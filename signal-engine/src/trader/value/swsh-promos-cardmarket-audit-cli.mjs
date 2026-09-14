import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasSupportedCentralCardmarketLane } from './cardmarket-approved-residual-recovery-cli.mjs';

const SET_NAME = 'SWSH Black Star Promos';
const TCGDEX_REVISION = '5b6a2859f454972477a9953ffe5cb554d24c45e9';
const POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();
const key = (...parts) => parts.map((part) => text(part)).join('|');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function collector(value) {
  try { return normaliseCollectorNumber(text(value)); } catch { return null; }
}

function promoNumberMatrix(value) {
  const raw = text(value).toUpperCase();
  const match = /^SWSH0*(\d+)$/.exec(raw);
  if (!match) return new Set([raw]);
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n < 0) return new Set([raw]);
  return new Set([
    `SWSH${String(n).padStart(3, '0')}`,
    `SWSH${String(n).padStart(2, '0')}`,
    `SWSH${n}`,
  ]);
}

function rawCollectorValues(product) {
  const row = product?.rawPayload || {};
  const values = [];
  for (const [field, value] of Object.entries(row)) {
    if (!/(collector|number|card.?no|local.?id|nr)/i.test(field)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item != null && text(item)) values.push({ field, value: text(item) });
    } else if (value != null && text(value)) {
      values.push({ field, value: text(value) });
    }
  }
  return values;
}

function productMatchesCollector(product, collectorNumber) {
  const target = promoNumberMatrix(collectorNumber);
  const evidence = rawCollectorValues(product);
  const matched = evidence.filter(({ value }) => {
    const candidate = text(value).toUpperCase().replace(/\s+/g, '');
    if (target.has(candidate)) return true;
    const normalized = collector(value);
    return normalized != null && normalized === collector(collectorNumber);
  });
  return Object.freeze({ matched: matched.length > 0, evidence: Object.freeze(matched) });
}

function exactVariantEvidence(card, variantCode) {
  const policy = POLICY[variantCode];
  if (!policy || !card) return Object.freeze({ ok: false, reason: 'UNSUPPORTED_OR_MISSING_CARD' });
  const exact = (card.variants || []).filter((variant) => variant?.type === policy.tcgdexType);
  if (exact.length === 0) return Object.freeze({ ok: false, reason: 'EXACT_FINISH_NOT_EXPLICIT', exact });
  if (exact.length > 1) return Object.freeze({ ok: false, reason: 'MULTIPLE_EXACT_FINISH_VARIANTS', exact });
  const variant = exact[0];
  const unstamped = !variant.subtype && !variant.foil && (!variant.stamp || variant.stamp.length === 0);
  const soleVariant = (card.variants || []).length === 1;
  return Object.freeze({ ok: true, variant, unstamped, soleVariant, exactCount: exact.length });
}

function currentPriceEvidence(priceRow, variantCode, finishEvidence) {
  const standard = hasSupportedCentralCardmarketLane(priceRow, 'standard');
  const holo = hasSupportedCentralCardmarketLane(priceRow, 'holo');
  if (variantCode === 'standard') {
    return Object.freeze({ status: standard ? 'PRICEABLE_STANDARD_LANE' : 'PRICE_UNAVAILABLE', standard, holo, approvedLane: standard ? 'standard' : null });
  }
  if (variantCode === 'holo') {
    if (holo) return Object.freeze({ status: 'PRICEABLE_HOLO_LANE', standard, holo, approvedLane: 'holo' });
    if (standard && finishEvidence?.ok && finishEvidence.soleVariant && finishEvidence.unstamped) {
      return Object.freeze({ status: 'REVIEW_BASE_LANE_AS_PROVEN_SINGLE_HOLO', standard, holo, approvedLane: null });
    }
    return Object.freeze({ status: 'PRICE_UNAVAILABLE', standard, holo, approvedLane: null });
  }
  return Object.freeze({ status: 'UNSUPPORTED_FINISH', standard, holo, approvedLane: null });
}

function stableMappingId(identityId, productId, sourceVariantKey) {
  return `fdcardmap_${createHash('sha256').update(`${identityId}|cardmarket|${productId}|${sourceVariantKey}`).digest('hex').slice(0, 24)}`;
}

export async function build(db, { repoEvidence, sources } = {}) {
  if (text(process.env.TCGDEX_REVISION) !== TCGDEX_REVISION) throw new Error('Pinned TCGdex revision mismatch');
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const matchingSets = repo.sets.filter((set) => set.setName === SET_NAME);
  if (matchingSets.length !== 1) throw new Error(`Expected exactly one pinned TCGdex ${SET_NAME} set, found ${matchingSets.length}`);
  const set = matchingSets[0];
  const expansionId = Number(set.cardmarketExpansionId);
  if (!Number.isSafeInteger(expansionId) || expansionId <= 0) {
    throw new Error('Pinned TCGdex SWSH promo set has no explicit Cardmarket expansion id; set scope is not independently proven');
  }

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const expansionProducts = products.filter((row) => Number(row.sourceExpansionId) === expansionId);
  if (!expansionProducts.length) throw new Error('Official Cardmarket catalogue contains no products for the pinned SWSH promo expansion');

  const numberFieldFrequency = {};
  for (const product of expansionProducts) {
    for (const { field } of rawCollectorValues(product)) numberFieldFrequency[field] = (numberFieldFrequency[field] || 0) + 1;
  }

  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.id AS set_id,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids,
      ARRAY(SELECT m.source_record_id || ':' || COALESCE(m.source_variant_key,'') FROM fatedrop_card_source_mappings m
        WHERE m.card_identity_id=i.id AND m.source_name='cardmarket' ORDER BY m.source_record_id,m.source_variant_key) AS cardmarket_mappings
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE s.name=$1
      AND i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY p.collector_number,i.variant_code,i.id`, [SET_NAME]);

  const { rows: existingOwners } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existingOwners) {
    const sourceKey = key(row.source_record_id,row.source_variant_key);
    const ids = owners.get(sourceKey) || new Set();
    ids.add(row.card_identity_id);
    owners.set(sourceKey,ids);
  }

  const cards = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));
  const results = [];
  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };

  for (const row of rows) {
    const identity = Object.freeze({
      cardIdentityId: row.id,
      setId: row.set_id,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
    });
    const policy = POLICY[row.variant_code];
    const tcgdexIds = row.tcgdex_card_ids || [];
    const existingMappings = row.cardmarket_mappings || [];
    let status = null;
    let card = null;
    let finish = null;
    let candidate = null;
    let method = null;
    let collectorEvidence = [];

    if (!policy) status = 'HOLD_UNSUPPORTED_FINISH';
    else if (tcgdexIds.length !== 1) status = 'HOLD_TCGDEX_LINK_COUNT';
    else {
      card = cards.get(tcgdexIds[0]);
      if (!card) status = 'HOLD_TCGDEX_CARD_MISSING';
      else if (!rootProductNameMatches(row.name, card.name)) status = 'HOLD_TCGDEX_NAME_MISMATCH';
      else if (collector(row.collector_number) !== collector(card.localId)) status = 'HOLD_TCGDEX_COLLECTOR_MISMATCH';
      else {
        finish = exactVariantEvidence(card,row.variant_code);
        if (!finish.ok) status = `HOLD_${finish.reason}`;
      }
    }

    if (!status && existingMappings.length > 0) {
      if (existingMappings.length !== 1) status = 'HOLD_MULTIPLE_EXISTING_CARDMARKET_MAPPINGS';
      else {
        const [sourceRecordId,sourceVariantKey] = existingMappings[0].split(':');
        if (sourceVariantKey !== policy.sourceVariantKey) status = 'HOLD_EXISTING_MAPPING_FINISH_MISMATCH';
        else {
          candidate = productById.get(sourceRecordId) || null;
          if (!candidate) status = 'HOLD_MAPPED_PRODUCT_MISSING_FROM_CATALOGUE';
          else if (Number(candidate.sourceExpansionId) !== expansionId) status = 'HOLD_MAPPED_PRODUCT_EXPANSION_MISMATCH';
          else if (!rootProductNameMatches(row.name,candidate.name)) status = 'HOLD_MAPPED_PRODUCT_NAME_MISMATCH';
          else {
            method = 'existing_exact_mapping_revalidated';
            const price = currentPriceEvidence(priceById.get(sourceRecordId),row.variant_code,finish);
            status = price.status;
          }
        }
      }
    }

    if (!status) {
      const exactProductId = finish?.variant?.cardmarketProductId ? String(finish.variant.cardmarketProductId) : null;
      if (exactProductId) {
        const product = productById.get(exactProductId) || null;
        if (!product) status = 'HOLD_EXPLICIT_PRODUCT_MISSING_FROM_CATALOGUE';
        else if (Number(product.sourceExpansionId) !== expansionId) status = 'HOLD_EXPLICIT_PRODUCT_EXPANSION_MISMATCH';
        else if (!rootProductNameMatches(row.name,product.name)) status = 'HOLD_EXPLICIT_PRODUCT_NAME_MISMATCH';
        else {
          candidate = product;
          method = 'pinned_tcgdex_exact_finish_product_id';
        }
      } else {
        const sameName = expansionProducts.filter((product) => rootProductNameMatches(row.name,product.name));
        const numbered = sameName.map((product) => ({ product, match: productMatchesCollector(product,row.collector_number) })).filter(({ match }) => match.matched);
        if (numbered.length === 1) {
          candidate = numbered[0].product;
          collectorEvidence = numbered[0].match.evidence;
          method = 'expansion_name_plus_three_tier_collector_number';
        } else if (numbered.length > 1) {
          status = 'HOLD_MULTIPLE_NUMBER_MATCHES';
        } else if (sameName.length === 1 && rawCollectorValues(sameName[0]).length === 0) {
          status = 'HOLD_NO_PROVIDER_COLLECTOR_NUMBER_EVIDENCE';
        } else if (sameName.length === 0) {
          status = 'HOLD_NO_PRODUCT_NAME_MATCH';
        } else {
          status = 'HOLD_NO_UNIQUE_NUMBER_MATCH';
        }
      }

      if (!status && candidate) {
        const sourceRecordId = String(candidate.sourceRecordId);
        const sourceOwners = owners.get(key(sourceRecordId,policy.sourceVariantKey));
        if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(row.id))) {
          status = 'HOLD_PRODUCT_ALREADY_OWNED';
        } else {
          const price = currentPriceEvidence(priceById.get(sourceRecordId),row.variant_code,finish);
          status = price.status;
        }
      }
    }

    bump(status);
    const sourceRecordId = candidate ? String(candidate.sourceRecordId) : existingMappings.length === 1 ? existingMappings[0].split(':')[0] : null;
    results.push(Object.freeze({
      ...identity,
      tcgdexCardId: tcgdexIds.length === 1 ? tcgdexIds[0] : null,
      existingCardmarketMappings: existingMappings,
      status,
      method,
      sourceRecordId,
      sourceVariantKey: policy?.sourceVariantKey ?? null,
      priceLane: policy?.priceLane ?? null,
      cardmarketProductName: candidate?.name ?? null,
      collectorEvidence,
      exactFinishEvidence: finish ? Object.freeze({
        ok: finish.ok,
        soleVariant: finish.soleVariant,
        unstamped: finish.unstamped,
        explicitProductId: finish.variant?.cardmarketProductId ? String(finish.variant.cardmarketProductId) : null,
      }) : null,
      proposedMappingId: sourceRecordId && policy ? stableMappingId(row.id,sourceRecordId,policy.sourceVariantKey) : null,
    }));
  }

  const unmapped = results.filter((row) => row.existingCardmarketMappings.length === 0);
  const mapped = results.filter((row) => row.existingCardmarketMappings.length > 0);
  const safeMappingStatuses = new Set(['PRICEABLE_STANDARD_LANE','PRICEABLE_HOLO_LANE','REVIEW_BASE_LANE_AS_PROVEN_SINGLE_HOLO','PRICE_UNAVAILABLE']);
  const mappingCandidates = unmapped.filter((row) => row.sourceRecordId && safeMappingStatuses.has(row.status));
  const baseLaneReview = results.filter((row) => row.status === 'REVIEW_BASE_LANE_AS_PROVEN_SINGLE_HOLO');
  const directlyPriceable = results.filter((row) => ['PRICEABLE_STANDARD_LANE','PRICEABLE_HOLO_LANE'].includes(row.status));
  const priceUnavailable = results.filter((row) => row.status === 'PRICE_UNAVAILABLE');

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      tcgdexRevision: TCGDEX_REVISION,
      tcgdexSetId: set.tcgdexSetId,
      cardmarketExpansionId: expansionId,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({
      unpricedCohort: results.length,
      unmapped: unmapped.length,
      mappedUnpriced: mapped.length,
      unmappedHolo: unmapped.filter((row) => row.variantCode === 'holo').length,
      unmappedStandard: unmapped.filter((row) => row.variantCode === 'standard').length,
      mappingCandidates: mappingCandidates.length,
      directlyPriceable: directlyPriceable.length,
      baseLaneHoloReview: baseLaneReview.length,
      priceUnavailable: priceUnavailable.length,
      held: results.length - directlyPriceable.length - baseLaneReview.length - priceUnavailable.length,
      expansionProducts: expansionProducts.length,
    }),
    numberFieldFrequency: Object.freeze(numberFieldFrequency),
    cohortDigest: digest(results.map((row) => [row.cardIdentityId,row.variantCode,row.name,row.collectorNumber,row.existingCardmarketMappings])),
    candidateDigest: digest(mappingCandidates.map((row) => [row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.status])),
    reasons: Object.freeze(reasons),
    mappingCandidates: Object.freeze(mappingCandidates),
    baseLaneHoloReview: Object.freeze(baseLaneReview),
    priceUnavailable: Object.freeze(priceUnavailable),
    rows: Object.freeze(results),
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    report = await build(db);
    await db.query('COMMIT');
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch {}
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/swsh-promos-cardmarket-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, numberFieldFrequency: report.numberFieldFrequency, reasons: report.reasons, cohortDigest: report.cohortDigest, candidateDigest: report.candidateDigest, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
