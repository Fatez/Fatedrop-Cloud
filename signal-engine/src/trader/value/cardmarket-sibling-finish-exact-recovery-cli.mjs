import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const key = (...parts) => parts.join('|');
const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
const sourceVariantFor = Object.freeze({ standard: 'normal', holo: 'holo' });
const priceLaneFor = Object.freeze({ standard: 'standard', holo: 'holo' });

export async function build(db, { repoEvidence, sources } = {}) {
  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    (sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue()),
    (sources?.guide ?? fetchCardmarketPokemonPriceGuide()),
  ]);

  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: eligible } = await db.query(`
    SELECT i.id, i.printing_id, i.variant_code, i.set_id, p.name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )`);

  const eligibleById = new Map(eligible.map((row) => [row.id, row]));
  const { rows: siblingRows } = await db.query(`
    SELECT target.id target_identity_id,
           sibling.id sibling_identity_id,
           sibling.variant_code sibling_variant_code,
           mapping.source_record_id,
           mapping.source_variant_key
    FROM fatedrop_card_identities target
    JOIN fatedrop_card_identities sibling
      ON sibling.printing_id=target.printing_id
     AND sibling.id<>target.id
     AND sibling.language_code='en'
     AND sibling.verification_status='verified'
     AND sibling.variant_code IN ('standard','holo')
     AND sibling.variant_code<>target.variant_code
    JOIN fatedrop_card_source_mappings mapping
      ON mapping.card_identity_id=sibling.id
     AND mapping.source_name='cardmarket'
    WHERE target.verification_status='verified'
      AND target.language_code='en'
      AND target.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings existing
        WHERE existing.source_name='cardmarket' AND existing.card_identity_id=target.id
      )`);

  const siblingsByTarget = new Map();
  for (const row of siblingRows) {
    if (!eligibleById.has(row.target_identity_id)) continue;
    const list = siblingsByTarget.get(row.target_identity_id) || [];
    list.push(row);
    siblingsByTarget.set(row.target_identity_id, list);
  }

  const { rows: existing } = await db.query(`
    SELECT card_identity_id, source_record_id, source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const existingSource = new Map(existing.map((row) => [key(row.source_record_id, row.source_variant_key), row.card_identity_id]));
  const existingCanonical = new Map(existing.map((row) => [key(row.card_identity_id, row.source_variant_key), String(row.source_record_id)]));

  const raw = [];
  const unresolved = [];
  const ambiguous = [];
  const conflicts = [];
  let withMappedOppositeFinish = 0;
  let uniqueSiblingProduct = 0;
  let targetLanePriceable = 0;

  for (const identity of eligible) {
    const siblings = siblingsByTarget.get(identity.id) || [];
    if (siblings.length === 0) {
      unresolved.push({ id: identity.id, reason: 'no_mapped_opposite_finish_sibling' });
      continue;
    }
    withMappedOppositeFinish++;

    const productIds = [...new Set(siblings.map((row) => String(row.source_record_id)))];
    if (productIds.length !== 1) {
      ambiguous.push({
        id: identity.id,
        reason: 'opposite_finish_siblings_map_to_multiple_cardmarket_products',
        sourceRecordIds: productIds.sort(),
      });
      continue;
    }
    uniqueSiblingProduct++;

    const sourceRecordId = productIds[0];
    const product = productById.get(sourceRecordId);
    if (!product) {
      unresolved.push({ id: identity.id, reason: 'sibling_product_missing_from_current_cardmarket_catalogue', sourceRecordId });
      continue;
    }

    const sourceVariantKey = sourceVariantFor[identity.variant_code];
    const targetLane = priceLaneFor[identity.variant_code];
    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, targetLane)) {
      unresolved.push({ id: identity.id, reason: 'target_finish_has_no_meaningful_cardmarket_price_lane', sourceRecordId, targetLane });
      continue;
    }
    targetLanePriceable++;

    const sourceKey = key(sourceRecordId, sourceVariantKey);
    const canonicalKey = key(identity.id, sourceVariantKey);
    if (existingSource.has(sourceKey) && existingSource.get(sourceKey) !== identity.id) {
      conflicts.push({ id: identity.id, reason: 'target_source_finish_owned', sourceRecordId, sourceVariantKey, existingCardIdentityId: existingSource.get(sourceKey) });
      continue;
    }
    if (existingCanonical.has(canonicalKey) && existingCanonical.get(canonicalKey) !== sourceRecordId) {
      conflicts.push({ id: identity.id, reason: 'target_identity_finish_owned_by_other_product', sourceRecordId, sourceVariantKey, existingSourceRecordId: existingCanonical.get(canonicalKey) });
      continue;
    }

    const siblingEvidence = siblings
      .filter((row) => String(row.source_record_id) === sourceRecordId)
      .map((row) => ({
        cardIdentityId: row.sibling_identity_id,
        variantCode: row.sibling_variant_code,
        sourceVariantKey: row.source_variant_key,
      }));

    raw.push({
      id: stableId('fdcardmap', [identity.id, 'cardmarket', sourceRecordId, sourceVariantKey]),
      cardIdentityId: identity.id,
      printingId: identity.printing_id,
      variantCode: identity.variant_code,
      cardName: identity.name,
      sourceRecordId,
      sourceVariantKey,
      sourceVersion: catalogue.sha256,
      proof: {
        method: 'same_printing_single_exact_cardmarket_product_with_meaningful_target_finish_lane',
        targetLane,
        cardmarketProductName: product.name,
        siblingEvidence,
      },
    });
  }

  const sourceOwners = new Map();
  const canonicalOwners = new Map();
  const badSource = new Set();
  const badCanonical = new Set();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    const canonicalKey = key(row.cardIdentityId, row.sourceVariantKey);
    if (sourceOwners.has(sourceKey) && sourceOwners.get(sourceKey) !== row.cardIdentityId) badSource.add(sourceKey);
    else sourceOwners.set(sourceKey, row.cardIdentityId);
    if (canonicalOwners.has(canonicalKey) && canonicalOwners.get(canonicalKey) !== row.sourceRecordId) badCanonical.add(canonicalKey);
    else canonicalOwners.set(canonicalKey, row.sourceRecordId);
  }

  const candidates = raw.filter((row) =>
    !badSource.has(key(row.sourceRecordId, row.sourceVariantKey))
    && !badCanonical.has(key(row.cardIdentityId, row.sourceVariantKey)));

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
    },
    counts: {
      eligibleUnmappedNormalHolo: eligible.length,
      withMappedOppositeFinish,
      uniqueSiblingProduct,
      targetLanePriceable,
      safeExactMappings: candidates.length,
      ambiguous: ambiguous.length,
      unresolved: unresolved.length,
      conflicts: conflicts.length + badSource.size + badCanonical.size,
      batchSourceConflicts: badSource.size,
      batchCanonicalConflicts: badCanonical.size,
    },
    candidates,
    ambiguous,
    unresolved,
    conflicts,
  };
}

async function persist(db, report) {
  await db.query('BEGIN');
  try {
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT id, printing_id, variant_code
        FROM fatedrop_card_identities
        WHERE id=$1 AND verification_status='verified' AND language_code='en'`, [row.cardIdentityId]);
      if (!target.rows[0]) throw new Error('Target identity eligibility changed');
      if (target.rows[0].printing_id !== row.printingId || target.rows[0].variant_code !== row.variantCode) {
        throw new Error('Target printing or finish changed');
      }

      const siblingProducts = await db.query(`
        SELECT DISTINCT mapping.source_record_id
        FROM fatedrop_card_identities sibling
        JOIN fatedrop_card_source_mappings mapping
          ON mapping.card_identity_id=sibling.id AND mapping.source_name='cardmarket'
        WHERE sibling.printing_id=$1
          AND sibling.id<>$2
          AND sibling.language_code='en'
          AND sibling.verification_status='verified'
          AND sibling.variant_code IN ('standard','holo')
          AND sibling.variant_code<>$3
        ORDER BY mapping.source_record_id`, [row.printingId, row.cardIdentityId, row.variantCode]);
      const currentProducts = siblingProducts.rows.map((result) => String(result.source_record_id));
      if (currentProducts.length !== 1 || currentProducts[0] !== row.sourceRecordId) {
        throw new Error('Sibling Cardmarket product evidence changed');
      }

      const source = await db.query(`
        SELECT card_identity_id
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`, [row.sourceRecordId, row.sourceVariantKey]);
      if (source.rows[0] && source.rows[0].card_identity_id !== row.cardIdentityId) {
        throw new Error('Cardmarket source finish ownership changed');
      }

      const canonical = await db.query(`
        SELECT source_record_id
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`, [row.cardIdentityId, row.sourceVariantKey]);
      if (canonical.rows[0] && String(canonical.rows[0].source_record_id) !== row.sourceRecordId) {
        throw new Error('Canonical Cardmarket finish mapping changed');
      }

      await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)
        ON CONFLICT(id) DO NOTHING`,
      [row.id, row.cardIdentityId, row.sourceRecordId, row.sourceVariantKey, row.sourceVersion, Date.now()]);
    }
    await db.query('COMMIT');
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
    if (process.env.MAPPING_WRITE === 'true') {
      await persist(db, report);
      report = { ...report, status: 'write_complete', productionWrites: true };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-sibling-finish-exact-recovery.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
