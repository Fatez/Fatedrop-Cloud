import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-url-first-sample-crosswalk-2026-09-15.json');
const BASE_REPORT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-rebuild.json');

const fold = (value) => String(value ?? '').trim().toLowerCase();
const sourceVariantKey = (variantCode) => variantCode === 'holo' ? 'holo' : 'normal';

async function loadEvidence() {
  const payload = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (payload?.schemaVersion !== 1 || payload?.productionWrites !== false || !Array.isArray(payload?.rows) || payload.rows.length === 0) {
    throw new Error('Invalid URL-first sample evidence');
  }
  return payload;
}

export async function build(db) {
  const evidence = await loadEvidence();
  const baseReport = JSON.parse(await readFile(BASE_REPORT(), 'utf8'));
  if (baseReport?.status !== 'audit_complete' || baseReport?.productionWrites !== false) throw new Error('Read-only base report required');

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const residualByIdentity = new Map((baseReport.currentUnmappedResidual || []).map((row) => [row.cardIdentityId, row]));
  const candidateByIdentity = new Map((baseReport.newMappingCandidates || []).map((row) => [row.cardIdentityId, row]));

  const validated = [];
  const held = [];
  const batchKeys = new Set();
  const counters = {
    reviewed: evidence.rows.length,
    exactCanonicalIdentity: 0,
    exactTcgId: 0,
    officialProductPresent: 0,
    productInsideBaseCandidateScope: 0,
    productNameCompatible: 0,
    sourceKeyFree: 0,
    collisionFree: 0,
    targetLanePriceable: 0,
    baseLanePriceableForHolo: 0,
    fullyValidated: 0,
  };

  for (const row of evidence.rows) {
    const sourceRecordId = String(row.cardmarketProductId);
    const expectedSourceVariantKey = sourceVariantKey(row.variantCode);
    const { rows: identities } = await db.query(`
      SELECT i.id,i.variant_code,i.language_code,i.verification_status,
        p.name,p.collector_number,s.name AS set_name,
        p.attributes->'artwork'->>'sourceRecordId' AS tcgdex_id
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=p.set_id
      WHERE i.id=$1`, [row.cardIdentityId]);
    const identity = identities[0];
    if (!identity
      || identity.verification_status !== 'verified'
      || identity.language_code !== 'en'
      || identity.variant_code !== row.variantCode
      || identity.set_name !== row.setName
      || identity.name !== row.name
      || fold(identity.collector_number) !== fold(row.collectorNumber)) {
      held.push({ ...row, reason: 'CANONICAL_IDENTITY_MISMATCH' });
      continue;
    }
    counters.exactCanonicalIdentity += 1;
    if (identity.tcgdex_id !== row.tcgId) {
      held.push({ ...row, reason: 'TCG_ID_MISMATCH', observedTcgId: identity.tcgdex_id });
      continue;
    }
    counters.exactTcgId += 1;

    const product = productById.get(sourceRecordId);
    if (!product) {
      held.push({ ...row, reason: 'PRODUCT_ABSENT_FROM_OFFICIAL_CARDMARKET_CATALOGUE' });
      continue;
    }
    counters.officialProductPresent += 1;

    const base = residualByIdentity.get(row.cardIdentityId) || candidateByIdentity.get(row.cardIdentityId);
    const scopedIds = new Set((base?.model?.candidates || []).map((candidate) => String(candidate.sourceRecordId)));
    if (base?.model?.status === 'resolved' && base?.model?.sourceRecordId) scopedIds.add(String(base.model.sourceRecordId));
    if (!scopedIds.has(sourceRecordId)) {
      held.push({ ...row, reason: 'PRODUCT_OUTSIDE_URL_FIRST_CARDMARKET_SCOPE', productName: product.name, scopedIds: [...scopedIds] });
      continue;
    }
    counters.productInsideBaseCandidateScope += 1;

    if (!rootProductNameMatches(row.name, product.name)) {
      held.push({ ...row, reason: 'PRODUCT_NAME_MISMATCH', productName: product.name });
      continue;
    }
    counters.productNameCompatible += 1;

    const { rows: owners } = await db.query(`
      SELECT card_identity_id FROM fatedrop_card_source_mappings
      WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,
      [sourceRecordId, expectedSourceVariantKey]);
    if (owners.length > 0 && owners.some((owner) => owner.card_identity_id !== row.cardIdentityId)) {
      held.push({ ...row, reason: 'SOURCE_KEY_ALREADY_OWNED', owners: owners.map((owner) => owner.card_identity_id) });
      continue;
    }
    counters.sourceKeyFree += 1;

    const batchKey = `${sourceRecordId}|${expectedSourceVariantKey}`;
    if (batchKeys.has(batchKey)) {
      held.push({ ...row, reason: 'SAMPLE_SOURCE_COLLISION', batchKey });
      continue;
    }
    batchKeys.add(batchKey);
    counters.collisionFree += 1;

    const guide = priceById.get(sourceRecordId);
    const standardPrice = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'standard'));
    const holoPrice = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'holo'));
    const targetPrice = row.variantCode === 'holo' ? holoPrice : standardPrice;
    if (targetPrice) counters.targetLanePriceable += 1;
    if (row.variantCode === 'holo' && !holoPrice && standardPrice) counters.baseLanePriceableForHolo += 1;

    counters.fullyValidated += 1;
    validated.push({
      ...row,
      sourceRecordId,
      sourceVariantKey: expectedSourceVariantKey,
      cardmarketProductName: product.name,
      cardmarketExpansionId: product.sourceExpansionId ?? null,
      priceEvidence: { standard: standardPrice, holo: holoPrice, targetLane: targetPrice },
      proof: {
        canonicalIdentityExact: true,
        tcgIdExact: true,
        productInOfficialCatalogue: true,
        productInsideUrlFirstCandidateScope: true,
        productNameCompatible: true,
        sourceKeyFree: true,
        batchCollisionFree: true
      }
    });
  }

  return {
    status: held.length === 0 ? 'sample_passed' : 'sample_held',
    productionWrites: false,
    counts: counters,
    source: {
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId
    },
    validated,
    held
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    if (report.status !== 'sample_passed') process.exitCode = 1;
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-sample-validation.json');
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, counts: report.counts, held: report.held }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
