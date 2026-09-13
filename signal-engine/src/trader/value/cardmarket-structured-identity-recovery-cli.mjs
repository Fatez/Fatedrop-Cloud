import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { buildEnglishPricingScope } from './english-pricing-bundle.mjs';

export const TARGET_POLICY = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});

function stableId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}

function sourceKey(sourceRecordId, sourceVariantKey) {
  return `${sourceRecordId}|${sourceVariantKey}`;
}

function normalizedCollector(value) {
  try {
    return normaliseCollectorNumber(value);
  } catch {
    return null;
  }
}

function providerNameMatch(identityName, providerName) {
  if (rootProductNameMatches(identityName, providerName)) {
    return Object.freeze({ ok: true, basis: 'exact_provider_name' });
  }

  // Cardmarket uses terminal V1/V2/etc. artwork labels on some historical
  // products. They are provider artwork-version labels, not Pokemon V cards.
  const withoutArtworkVersion = String(providerName || '').replace(/\s+\(?V\d+\)?\s*$/i, '').trim();
  if (withoutArtworkVersion !== String(providerName || '').trim()
      && rootProductNameMatches(identityName, withoutArtworkVersion)) {
    return Object.freeze({ ok: true, basis: 'provider_artwork_version_suffix' });
  }

  return Object.freeze({ ok: false, basis: null });
}

export function buildStructuredProductIndex(products) {
  const byExpansion = new Map();
  for (const product of products || []) {
    const expansionId = Number(product?.sourceExpansionId);
    if (!Number.isSafeInteger(expansionId) || expansionId <= 0) continue;
    const parsed = parseCardmarketSingleProductName(product.name);
    if (!parsed) continue;
    const collectorNumber = normalizedCollector(parsed.collectorNumber);
    if (!collectorNumber) continue;
    const rows = byExpansion.get(expansionId) || [];
    rows.push(Object.freeze({ product, parsed, collectorNumber }));
    byExpansion.set(expansionId, rows);
  }
  return byExpansion;
}

export function resolveStructuredIdentity(identity, {
  productIndex,
  priceByProduct,
  sourceOwners = new Map(),
} = {}) {
  const policy = TARGET_POLICY[identity?.variantCode];
  if (!policy) return Object.freeze({ status: 'HOLD_UNSUPPORTED_FINISH', candidates: Object.freeze([]) });

  const expansionIds = [...new Set((identity.cardmarketExpansionIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (expansionIds.length === 0) {
    return Object.freeze({ status: 'HOLD_SET_MAPPING_MISSING', candidates: Object.freeze([]) });
  }
  if (expansionIds.length !== 1) {
    return Object.freeze({ status: 'HOLD_SET_MAPPING_AMBIGUOUS', candidates: Object.freeze([]) });
  }

  const collectorNumber = normalizedCollector(identity.collectorNumber);
  if (!collectorNumber) {
    return Object.freeze({ status: 'HOLD_COLLECTOR_NUMBER_INVALID', candidates: Object.freeze([]) });
  }

  const expansionId = expansionIds[0];
  const exact = [];
  for (const entry of productIndex.get(expansionId) || []) {
    if (entry.collectorNumber !== collectorNumber) continue;
    const nameMatch = providerNameMatch(identity.name, entry.parsed.cardName);
    if (!nameMatch.ok) continue;
    exact.push(Object.freeze({ ...entry, nameMatchBasis: nameMatch.basis }));
  }

  if (exact.length === 0) {
    return Object.freeze({ status: 'HOLD_NO_STRUCTURED_MATCH', expansionId, candidates: Object.freeze([]) });
  }
  if (exact.length !== 1) {
    return Object.freeze({
      status: 'HOLD_MULTIPLE_PRODUCTS',
      expansionId,
      candidates: Object.freeze(exact.map((entry) => Object.freeze({
        sourceRecordId: String(entry.product.sourceRecordId),
        productName: entry.product.name,
        sourceMetacardId: entry.product.sourceMetacardId ?? null,
        nameMatchBasis: entry.nameMatchBasis,
      }))),
    });
  }

  const match = exact[0];
  const sourceRecordId = String(match.product.sourceRecordId);
  const priceRow = priceByProduct.get(sourceRecordId);
  if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, policy.priceLane)) {
    return Object.freeze({
      status: 'HOLD_PRICE_LANE_MISSING',
      expansionId,
      sourceRecordId,
      productName: match.product.name,
      priceLane: policy.priceLane,
      candidates: Object.freeze([]),
    });
  }

  const owner = sourceOwners.get(sourceKey(sourceRecordId, policy.sourceVariantKey));
  if (owner && owner !== identity.cardIdentityId) {
    return Object.freeze({
      status: 'HOLD_PRODUCT_ALREADY_OWNED',
      expansionId,
      sourceRecordId,
      productName: match.product.name,
      existingCardIdentityId: owner,
      candidates: Object.freeze([]),
    });
  }

  return Object.freeze({
    status: 'SAFE_MAPPING_CANDIDATE',
    expansionId,
    candidate: Object.freeze({
      cardIdentityId: identity.cardIdentityId,
      setId: identity.setId,
      setName: identity.setName,
      name: identity.name,
      collectorNumber: identity.collectorNumber,
      variantCode: identity.variantCode,
      sourceRecordId,
      sourceVariantKey: policy.sourceVariantKey,
      priceLane: policy.priceLane,
      cardmarketProductName: match.product.name,
      sourceExpansionId: expansionId,
      sourceMetacardId: match.product.sourceMetacardId ?? null,
      nameMatchBasis: match.nameMatchBasis,
    }),
    candidates: Object.freeze([]),
  });
}

function reasonCount(rows) {
  return rows.reduce((out, row) => {
    out[row.status] = (out[row.status] || 0) + 1;
    return out;
  }, {});
}

export async function build(db, { sources } = {}) {
  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);

  const { rows: sourceIdentities } = await db.query(`
    SELECT i.id,i.set_id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,s.name AS set_name,
      rs.classifier_state,
      ARRAY(SELECT DISTINCT m.source_record_id FROM fatedrop_card_set_source_mappings m
        WHERE m.set_id=i.set_id AND m.source_name='cardmarket' ORDER BY m.source_record_id) AS cardmarket_expansion_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.language_code='en' AND i.verification_status='verified' AND i.variant_code IN ('standard','holo')
    ORDER BY i.id`);
  const pricingScope = buildEnglishPricingScope(sourceIdentities);
  const eligibleIds = new Set(pricingScope.eligibleCards.map((row) => row.id));

  const { rows: pricedRows } = await db.query(`
    SELECT DISTINCT card_identity_id FROM fatedrop_market_observations
    WHERE source_name='cardmarket' AND greatest(market_price,trend_price,avg_1d,avg_7d,avg_30d)>0
    ORDER BY card_identity_id`);
  const priced = new Set(pricedRows.filter((row) => eligibleIds.has(row.card_identity_id)).map((row) => row.card_identity_id));

  const { rows: existingMappings } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
    ORDER BY card_identity_id,source_record_id,source_variant_key`);
  const mapped = new Set(existingMappings.map((row) => row.card_identity_id));
  const sourceOwners = new Map();
  for (const row of existingMappings) {
    const key = sourceKey(String(row.source_record_id), row.source_variant_key);
    const previous = sourceOwners.get(key);
    if (previous && previous !== row.card_identity_id) sourceOwners.set(key, '__CONFLICT__');
    else sourceOwners.set(key, row.card_identity_id);
  }

  const sectionB = pricingScope.eligibleCards
    .filter((row) => !priced.has(row.id) && !mapped.has(row.id))
    .map((row) => Object.freeze({
      cardIdentityId: row.id,
      setId: row.set_id,
      setName: row.set_name,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      cardmarketExpansionIds: row.cardmarket_expansion_ids,
    }));

  const productIndex = buildStructuredProductIndex(products);
  const priceByProduct = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const resolutions = sectionB.map((identity) => Object.freeze({
    identity,
    ...resolveStructuredIdentity(identity, { productIndex, priceByProduct, sourceOwners }),
  }));

  const preliminary = resolutions
    .filter((row) => row.status === 'SAFE_MAPPING_CANDIDATE')
    .map((row) => row.candidate);
  const batchOwners = new Map();
  const collisionKeys = new Set();
  for (const candidate of preliminary) {
    const key = sourceKey(candidate.sourceRecordId, candidate.sourceVariantKey);
    const previous = batchOwners.get(key);
    if (previous && previous !== candidate.cardIdentityId) collisionKeys.add(key);
    else batchOwners.set(key, candidate.cardIdentityId);
  }

  const candidates = [];
  const finalResolutions = resolutions.map((row) => {
    if (row.status !== 'SAFE_MAPPING_CANDIDATE') return row;
    const key = sourceKey(row.candidate.sourceRecordId, row.candidate.sourceVariantKey);
    if (collisionKeys.has(key)) {
      return Object.freeze({ identity: row.identity, status: 'HOLD_BATCH_SOURCE_COLLISION', candidates: Object.freeze([]) });
    }
    const candidate = Object.freeze({
      id: stableId('fdcardmap', [row.candidate.cardIdentityId, 'cardmarket', row.candidate.sourceRecordId, row.candidate.sourceVariantKey]),
      ...row.candidate,
      sourceVersion: catalogue.sha256,
      proof: Object.freeze({
        method: 'cardmarket_official_catalogue_exact_expansion_name_collector_plus_price_lane',
        catalogueSha256: catalogue.sha256,
        priceGuideSha256: guide.sha256,
        nameMatchBasis: row.candidate.nameMatchBasis,
      }),
    });
    candidates.push(candidate);
    return Object.freeze({ ...row, candidate });
  });

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      cardmarketPriceGuideEffectiveAt: snapshot.sourceEffectiveAt,
    }),
    pricingEligibility: Object.freeze({
      sourceCardCount: pricingScope.sourceCardCount,
      eligibleCardCount: pricingScope.eligibleCardCount,
      excludedInvalidCatalogueEntryCount: pricingScope.excludedInvalidCatalogueEntryCount,
      excludedUnresolvedEvidenceCount: pricingScope.excludedUnresolvedEvidenceCount,
    }),
    counts: Object.freeze({
      sectionB: sectionB.length,
      safeExactMappings: candidates.length,
      held: sectionB.length - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    }),
    reasons: Object.freeze(reasonCount(finalResolutions)),
    candidates: Object.freeze(candidates),
    resolutions: Object.freeze(finalResolutions),
  });
}

export async function persist(db, report) {
  if (report.status !== 'audit_complete') throw new Error('Structured identity recovery audit is not complete');
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-structured-identity-recovery'))`);
    let insertedMappings = 0;
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT i.id,i.variant_code,i.language_code,i.verification_status,rs.classifier_state
        FROM fatedrop_card_identities i
        LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
        WHERE i.id=$1 FOR UPDATE`, [row.cardIdentityId]);
      const current = target.rows[0];
      if (!current || current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) {
        throw new Error(`Canonical identity changed before write: ${row.cardIdentityId}`);
      }
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(current.classifier_state)) {
        throw new Error(`Resolution state became ineligible before write: ${row.cardIdentityId}`);
      }

      const identityMapping = await db.query(`
        SELECT source_record_id,source_variant_key FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (identityMapping.rowCount !== 0) throw new Error(`Cardmarket identity ownership changed: ${row.cardIdentityId}`);

      const sourceMapping = await db.query(`
        SELECT card_identity_id FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`,
      [row.sourceRecordId, row.sourceVariantKey]);
      if (sourceMapping.rowCount !== 0) throw new Error(`Cardmarket source ownership changed: ${row.sourceRecordId}/${row.sourceVariantKey}`);

      const now = Date.now();
      const result = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)
        RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,now]);
      insertedMappings += result.rowCount;
    }
    await db.query('COMMIT');
    return Object.freeze({ insertedMappings });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    const expected = Number(process.env.EXPECTED_SECTION_B || 0);
    if (expected > 0 && report.counts.sectionB !== expected) {
      throw new Error(`Section B drift: expected ${expected}, found ${report.counts.sectionB}`);
    }
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persist(db, report);
      report = Object.freeze({ ...report, status: 'write_complete', productionWrites: true, persistence });
    }
  } catch (error) {
    report = Object.freeze({ status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }

  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-structured-identity-recovery.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, counts: report.counts, reasons: report.reasons, persistence: report.persistence }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
