import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

import { normaliseCollectorNumber } from '../card-identity.mjs';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-final-46-user-urls-2026-09-15.json');
const EXPECTED = 46;
const finishPolicy = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});

function collector(value) {
  return normaliseCollectorNumber(String(value ?? '').trim());
}

function baselineEvidence(card, variantCode) {
  const policy = finishPolicy[variantCode];
  if (!policy) return { status: 'unresolved', reason: 'UNSUPPORTED_FINISH' };
  const variants = (card?.variants || []).filter((variant) =>
    variant?.type === policy.tcgdexType
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0);
  if (!variants.length) return { status: 'unresolved', reason: 'NO_BASELINE_FINISH_EVIDENCE' };
  const explicitIds = [...new Set(variants
    .map((variant) => Number(variant.cardmarketProductId))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (explicitIds.length > 1) {
    return { status: 'ambiguous', reason: 'MULTIPLE_BASELINE_PRODUCT_IDS', productIds: explicitIds };
  }
  const rootId = getRootCardmarketProductId(card);
  if (rootId && explicitIds.length === 1 && Number(rootId) !== explicitIds[0]) {
    return { status: 'ambiguous', reason: 'ROOT_BASELINE_PRODUCT_ID_CONFLICT', productIds: [Number(rootId), explicitIds[0]] };
  }
  const productId = explicitIds[0] ?? rootId;
  if (!productId) return { status: 'unresolved', reason: 'NO_EXPLICIT_CARDMARKET_PRODUCT_ID' };
  return {
    status: 'resolved',
    productId: String(productId),
    proof: explicitIds.length === 1
      ? 'tcgdex_explicit_baseline_finish_product_id'
      : 'tcgdex_root_product_plus_explicit_baseline_finish',
    baselineCount: variants.length,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const manifest = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (manifest.entries?.length !== EXPECTED) throw new Error(`Expected ${EXPECTED} reviewed entries`);

  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const ids = manifest.entries.map((row) => row.cardIdentityId);
    const { rows } = await db.query(`
      SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
             s.name AS set_name,rs.classifier_state,
             array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id)
               FILTER (WHERE t.source_record_id IS NOT NULL) AS tcgdex_card_ids
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      LEFT JOIN fatedrop_card_source_mappings t
        ON t.card_identity_id=i.id AND t.source_name='tcgdex'
      WHERE i.id=ANY($1::text[])
      GROUP BY i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
               s.name,rs.classifier_state`, [ids]);
    const canonicalById = new Map(rows.map((row) => [row.id, row]));

    const { rows: owners } = await db.query(`
      SELECT card_identity_id,source_record_id,source_variant_key
      FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
    const sourceOwners = new Map();
    const identityOwners = new Map();
    for (const row of owners) {
      const sourceKey = `${row.source_record_id}|${row.source_variant_key}`;
      const sourceRows = sourceOwners.get(sourceKey) || [];
      sourceRows.push(row);
      sourceOwners.set(sourceKey, sourceRows);
      const identityRows = identityOwners.get(row.card_identity_id) || [];
      identityRows.push(row);
      identityOwners.set(row.card_identity_id, identityRows);
    }

    const resolved = [];
    const ambiguous = [];
    const unresolved = [];
    for (const entry of manifest.entries) {
      const canonical = canonicalById.get(entry.cardIdentityId);
      if (!canonical) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'CANONICAL_IDENTITY_MISSING' });
        continue;
      }
      let canonicalOk = true;
      try {
        canonicalOk = canonical.verification_status === 'verified'
          && canonical.language_code === 'en'
          && canonical.variant_code === entry.variantCode
          && canonical.set_name === entry.setName
          && rootProductNameMatches(entry.name, canonical.name)
          && collector(entry.collectorNumber) === collector(canonical.collector_number)
          && !['INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE'].includes(canonical.classifier_state);
      } catch {
        canonicalOk = false;
      }
      if (!canonicalOk) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'CANONICAL_IDENTITY_DRIFT' });
        continue;
      }
      if (!Array.isArray(canonical.tcgdex_card_ids) || canonical.tcgdex_card_ids.length !== 1) {
        (canonical.tcgdex_card_ids?.length > 1 ? ambiguous : unresolved).push({
          cardIdentityId: entry.cardIdentityId,
          reason: canonical.tcgdex_card_ids?.length > 1 ? 'MULTIPLE_TCGDEX_LINKS' : 'NO_TCGDEX_LINK',
          tcgdexCardIds: canonical.tcgdex_card_ids || [],
        });
        continue;
      }
      const tcgdexCardId = canonical.tcgdex_card_ids[0];
      const card = cardById.get(tcgdexCardId);
      if (!card) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'TCGDEX_CARD_MISSING', tcgdexCardId });
        continue;
      }
      const evidence = baselineEvidence(card, entry.variantCode);
      if (evidence.status !== 'resolved') {
        (evidence.status === 'ambiguous' ? ambiguous : unresolved).push({
          cardIdentityId: entry.cardIdentityId,
          tcgdexCardId,
          ...evidence,
        });
        continue;
      }
      const product = productById.get(evidence.productId);
      if (!product) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'PRODUCT_ABSENT_FROM_OFFICIAL_CATALOGUE', sourceRecordId: evidence.productId });
        continue;
      }
      if (!rootProductNameMatches(entry.name, product.name)) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'PRODUCT_NAME_CONFLICT', sourceRecordId: evidence.productId, productName: product.name });
        continue;
      }
      const policy = finishPolicy[entry.variantCode];
      if (!hasMeaningfulCardmarketLane(priceById.get(evidence.productId), policy.priceLane)) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'NO_MEANINGFUL_PRICE_LANE', sourceRecordId: evidence.productId });
        continue;
      }
      const current = identityOwners.get(entry.cardIdentityId) || [];
      if (current.length > 1
        || (current.length === 1
          && (String(current[0].source_record_id) !== evidence.productId
            || current[0].source_variant_key !== policy.sourceVariantKey))) {
        ambiguous.push({ cardIdentityId: entry.cardIdentityId, reason: 'IDENTITY_MAPPING_OWNERSHIP_DRIFT' });
        continue;
      }
      const conflicting = (sourceOwners.get(`${evidence.productId}|${policy.sourceVariantKey}`) || [])
        .filter((owner) => owner.card_identity_id !== entry.cardIdentityId);
      if (conflicting.length) {
        ambiguous.push({ cardIdentityId: entry.cardIdentityId, reason: 'SOURCE_KEY_OWNED_BY_OTHER_IDENTITY', sourceRecordId: evidence.productId });
        continue;
      }
      resolved.push({
        cardIdentityId: entry.cardIdentityId,
        tcgdexCardId,
        sourceRecordId: evidence.productId,
        sourceVariantKey: policy.sourceVariantKey,
        sourceExpansionId: Number(product.sourceExpansionId),
        cardmarketProductName: product.name,
        proof: evidence.proof,
        existing: current.length === 1,
      });
    }

    const batchKeys = new Map();
    for (const row of resolved) {
      const key = `${row.sourceRecordId}|${row.sourceVariantKey}`;
      const values = batchKeys.get(key) || [];
      values.push(row.cardIdentityId);
      batchKeys.set(key, values);
    }
    const collided = new Set([...batchKeys.entries()].filter(([, values]) => values.length > 1).map(([key]) => key));
    if (collided.size) {
      const safe = [];
      for (const row of resolved) {
        const key = `${row.sourceRecordId}|${row.sourceVariantKey}`;
        if (collided.has(key)) ambiguous.push({ cardIdentityId: row.cardIdentityId, reason: 'BATCH_SOURCE_COLLISION', sourceRecordId: row.sourceRecordId });
        else safe.push(row);
      }
      resolved.splice(0, resolved.length, ...safe);
    }

    report = {
      status: resolved.length === EXPECTED && ambiguous.length === 0 && unresolved.length === 0 ? 'hard_proof_passed' : 'hard_proof_failed',
      productionWrites: false,
      source: {
        tcgdexRevision: process.env.TCGDEX_REVISION,
        cardmarketCatalogueSha256: catalogueArtifact.sha256,
        cardmarketPriceGuideSha256: guideArtifact.sha256,
        sourceSnapshotId: snapshot.sourceSnapshotId,
      },
      counts: { reviewed: EXPECTED, resolved: resolved.length, ambiguous: ambiguous.length, unresolved: unresolved.length },
      resolved,
      ambiguous,
      unresolved,
    };
  } finally {
    db.release();
    await pool.end();
  }

  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-final-46-diagnostic.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`FINAL46_HARD_PROOF resolved=${report.counts.resolved}/${EXPECTED} ambiguous=${report.counts.ambiguous} unresolved=${report.counts.unresolved}`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'hard_proof_passed') process.exitCode = 1;
}

await main();
