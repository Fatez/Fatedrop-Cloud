import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-final-46-user-urls-2026-09-15.json');
const EXPECTED_LOCATOR_COUNT = 46;
const CARDMARKET_HOST = 'www.cardmarket.com';
const CARDMARKET_PREFIX = '/en/Pokemon/Products/Singles/';
const VALID_FINISHES = new Set(['standard', 'holo']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function collector(value) {
  return normaliseCollectorNumber(String(value ?? '').trim());
}

function compact(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[♀♂]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function mappingId(entry, sourceRecordId, sourceVariantKey) {
  return `fdcardmap_${sha256([entry.cardIdentityId, 'cardmarket', sourceRecordId, sourceVariantKey].join('|')).slice(0, 24)}`;
}

function sourceVariantKey(entry) {
  return entry.variantCode === 'holo' ? 'holo' : 'normal';
}

function priceLane(entry) {
  return entry.variantCode === 'holo' ? 'holo' : 'standard';
}

function centralPricePresent(row, lane) {
  const fields = lane === 'holo'
    ? ['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
    : ['trend', 'avg1', 'avg7', 'avg30'];
  return fields.some((field) => Number(row?.[field] || 0) > 0);
}

function locatorCanonical(entries) {
  return entries.map((row) => [row.setName,row.cardIdentityId,row.name,row.collectorNumber,row.variantCode,row.url].join('|')).join('\n');
}

function candidateDigest(rows) {
  return sha256([...rows]
    .map((row) => [row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceExpansionId].join('|'))
    .sort()
    .join('\n'));
}

function validateLocator(entry) {
  assert.ok(VALID_FINISHES.has(entry.variantCode), `Unsupported finish ${entry.variantCode}`);
  const url = new URL(entry.url);
  assert.equal(url.protocol, 'https:', `Cardmarket locator must use HTTPS: ${entry.cardIdentityId}`);
  assert.equal(url.hostname, CARDMARKET_HOST, `Unexpected Cardmarket locator host: ${entry.cardIdentityId}`);
  assert.ok(url.pathname.startsWith(CARDMARKET_PREFIX), `Unexpected Cardmarket locator path: ${entry.cardIdentityId}`);
  const segments = url.pathname.slice(CARDMARKET_PREFIX.length).split('/').filter(Boolean);
  assert.equal(segments.length, 2, `Cardmarket locator must contain set/card slugs: ${entry.cardIdentityId}`);
  const cardSlug = compact(segments[1]);
  assert.ok(cardSlug.startsWith(compact(entry.name)), `Cardmarket card slug/name mismatch: ${entry.cardIdentityId}`);
  assert.ok(cardSlug.endsWith(compact(entry.collectorNumber)), `Cardmarket card slug/collector mismatch: ${entry.cardIdentityId}`);
  return Object.freeze({ setSlug: segments[0], cardSlug: segments[1] });
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported final-46 manifest schema');
  assert.equal(manifest.policy?.priceProvider, 'cardmarket-public-download', 'Cardmarket provider policy drift');
  assert.equal(manifest.policy?.webPagePriceScraping, false, 'Cardmarket webpage scraping must remain disabled');
  assert.equal(manifest.entries?.length, EXPECTED_LOCATOR_COUNT, `Expected ${EXPECTED_LOCATOR_COUNT} reviewed URL entries`);
  const ids = new Set();
  for (const entry of manifest.entries) {
    assert.ok(entry.cardIdentityId && !ids.has(entry.cardIdentityId), `Duplicate/missing identity ${entry.cardIdentityId}`);
    ids.add(entry.cardIdentityId);
    validateLocator(entry);
  }
  assert.equal(sha256(locatorCanonical(manifest.entries)), manifest.locatorDigest, 'Reviewed locator manifest digest drift');
  return manifest;
}

function collectSetEvidence(existingMappings, productById) {
  const bySet = new Map();
  for (const row of existingMappings) {
    const product = productById.get(String(row.source_record_id));
    if (!product || !Number.isSafeInteger(Number(product.sourceExpansionId))) continue;
    const parsed = parseCardmarketSingleProductName(product.name);
    const state = bySet.get(row.set_name) || { expansionCounts: new Map(), sourceSetCodeCounts: new Map() };
    const expansionId = Number(product.sourceExpansionId);
    state.expansionCounts.set(expansionId, (state.expansionCounts.get(expansionId) || 0) + 1);
    if (parsed?.sourceSetCode) {
      const code = String(parsed.sourceSetCode).toUpperCase();
      state.sourceSetCodeCounts.set(code, (state.sourceSetCodeCounts.get(code) || 0) + 1);
    }
    bySet.set(row.set_name, state);
  }
  return bySet;
}

function supportedExpansionIds(state) {
  if (!state?.expansionCounts?.size) return new Set();
  const ranked = [...state.expansionCounts.entries()].sort((a,b) => b[1]-a[1] || a[0]-b[0]);
  const max = ranked[0][1];
  // Existing production mappings are corroboration, not a reason to pick an arbitrary winner.
  // Keep every expansion with meaningful support: either the leading expansion or >=2 exact existing mappings.
  return new Set(ranked.filter(([,count]) => count === max || count >= 2).map(([id]) => id));
}

function supportedSetCodes(state) {
  if (!state?.sourceSetCodeCounts?.size) return new Set();
  return new Set([...state.sourceSetCodeCounts.entries()].filter(([,count]) => count >= 2).map(([code]) => code));
}

function resolveProduct(entry, products, setState) {
  const expansionIds = supportedExpansionIds(setState);
  const sourceSetCodes = supportedSetCodes(setState);
  if (!expansionIds.size) return { status: 'held', reason: 'NO_EXISTING_SET_EXPANSION_EVIDENCE', matches: [] };

  const exact = [];
  for (const product of products) {
    const expansionId = Number(product.sourceExpansionId);
    if (!expansionIds.has(expansionId)) continue;
    const parsed = parseCardmarketSingleProductName(product.name);
    if (!parsed) continue;
    if (sourceSetCodes.size && !sourceSetCodes.has(String(parsed.sourceSetCode).toUpperCase())) continue;
    let parsedCollector;
    try { parsedCollector = collector(parsed.collectorNumber); } catch { continue; }
    if (parsedCollector !== collector(entry.collectorNumber)) continue;
    if (!rootProductNameMatches(entry.name, parsed.cardName)) continue;
    exact.push(product);
  }

  if (exact.length !== 1) {
    return {
      status: 'held',
      reason: exact.length === 0 ? 'NO_UNIQUE_OFFICIAL_CATALOGUE_MATCH' : 'MULTIPLE_OFFICIAL_CATALOGUE_MATCHES',
      matches: exact.map((row) => ({ sourceRecordId: row.sourceRecordId, name: row.name, sourceExpansionId: row.sourceExpansionId })),
    };
  }
  return { status: 'resolved', product: exact[0] };
}

async function canonicalRows(db, entries) {
  const ids = entries.map((row) => row.cardIdentityId);
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
      s.name AS set_name,rs.classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.id=ANY($1::text[])`, [ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

async function existingCardmarketMappingsForSets(db, setNames) {
  const { rows } = await db.query(`
    SELECT s.name AS set_name,m.card_identity_id,m.source_record_id,m.source_variant_key,m.id
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    WHERE m.source_name='cardmarket' AND s.name=ANY($1::text[])`, [setNames]);
  return rows;
}

async function allCardmarketOwners(db) {
  const { rows } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const byIdentity = new Map();
  const bySource = new Map();
  for (const row of rows) {
    const identities = byIdentity.get(row.card_identity_id) || [];
    identities.push(row);
    byIdentity.set(row.card_identity_id, identities);
    const key = `${row.source_record_id}|${row.source_variant_key}`;
    const sources = bySource.get(key) || [];
    sources.push(row);
    bySource.set(key, sources);
  }
  return { byIdentity, bySource };
}

export async function buildRelease(db, { sources } = {}) {
  const manifest = await loadManifest();
  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const canonical = await canonicalRows(db, manifest.entries);
  const setNames = [...new Set(manifest.entries.map((row) => row.setName))];
  const existingSetMappings = await existingCardmarketMappingsForSets(db, setNames);
  const setEvidence = collectSetEvidence(existingSetMappings, productById);
  const owners = await allCardmarketOwners(db);

  const candidates = [];
  const held = [];
  let exactExisting = 0;
  for (const entry of manifest.entries) {
    const row = canonical.get(entry.cardIdentityId);
    if (!row) { held.push({ ...entry, reason: 'CANONICAL_IDENTITY_MISSING' }); continue; }
    try {
      assert.equal(row.verification_status, 'verified');
      assert.equal(row.language_code, 'en');
      assert.equal(row.variant_code, entry.variantCode);
      assert.equal(row.set_name, entry.setName);
      assert.ok(rootProductNameMatches(entry.name, row.name));
      assert.equal(collector(row.collector_number), collector(entry.collectorNumber));
      assert.ok(!['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(row.classifier_state));
    } catch (error) {
      held.push({ ...entry, reason: 'CANONICAL_IDENTITY_DRIFT', detail: error.message });
      continue;
    }

    const resolved = resolveProduct(entry, products, setEvidence.get(entry.setName));
    if (resolved.status !== 'resolved') { held.push({ ...entry, reason: resolved.reason, matches: resolved.matches }); continue; }
    const product = resolved.product;
    const variantKey = sourceVariantKey(entry);
    const currentForIdentity = owners.byIdentity.get(entry.cardIdentityId) || [];
    const sourceOwners = owners.bySource.get(`${product.sourceRecordId}|${variantKey}`) || [];
    const expectedId = mappingId(entry, String(product.sourceRecordId), variantKey);

    if (currentForIdentity.length) {
      const exact = currentForIdentity.length === 1
        && String(currentForIdentity[0].source_record_id) === String(product.sourceRecordId)
        && currentForIdentity[0].source_variant_key === variantKey;
      if (!exact) { held.push({ ...entry, reason: 'IDENTITY_MAPPING_OWNERSHIP_DRIFT' }); continue; }
      exactExisting += 1;
    }
    if (sourceOwners.some((owner) => owner.card_identity_id !== entry.cardIdentityId)) {
      held.push({ ...entry, reason: 'SOURCE_KEY_OWNED_BY_OTHER_IDENTITY', sourceRecordId: String(product.sourceRecordId) });
      continue;
    }

    candidates.push(Object.freeze({
      ...entry,
      mappingId: expectedId,
      sourceRecordId: String(product.sourceRecordId),
      sourceVariantKey: variantKey,
      sourceExpansionId: Number(product.sourceExpansionId),
      cardmarketProductName: product.name,
      currentlyPriceable: centralPricePresent(priceById.get(String(product.sourceRecordId)), priceLane(entry)),
      exactExisting: currentForIdentity.length === 1,
    }));
  }

  const digest = candidateDigest(candidates);
  const priceable = candidates.filter((row) => row.currentlyPriceable).length;
  const expectedCount = Number(process.env.EXPECTED_FINAL46_COUNT || 0);
  const expectedDigest = String(process.env.EXPECTED_FINAL46_DIGEST || '').trim();
  if (expectedCount && candidates.length !== expectedCount) throw new Error(`Final-46 candidate count drift: expected ${expectedCount}, found ${candidates.length}`);
  if (expectedDigest && digest !== expectedDigest) throw new Error('Final-46 candidate digest drift');
  if (process.env.MAPPING_WRITE === 'true' && (!expectedCount || !expectedDigest)) {
    throw new Error('Production final-46 writes require pinned candidate count and digest');
  }

  return Object.freeze({
    status: held.length ? 'rehearsal_complete_with_holds' : 'rehearsal_complete',
    productionWrites: false,
    locatorDigest: manifest.locatorDigest,
    candidateDigest: digest,
    source: Object.freeze({
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({ reviewed: manifest.entries.length, candidates: candidates.length, held: held.length, exactExisting, missingMappings: candidates.length - exactExisting, currentlyPriceable: priceable }),
    candidates: Object.freeze(candidates),
    held: Object.freeze(held),
  });
}

async function persist(db, report) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-final-46-cardmarket-user-url-release'))`);
    let insertedMappings = 0;
    let existingMappings = 0;
    for (const row of report.candidates) {
      const identity = await db.query(`SELECT id,variant_code,language_code,verification_status FROM fatedrop_card_identities WHERE id=$1 FOR UPDATE`, [row.cardIdentityId]);
      assert.equal(identity.rowCount, 1, `Canonical identity vanished ${row.cardIdentityId}`);
      assert.equal(identity.rows[0].variant_code, row.variantCode);
      assert.equal(identity.rows[0].language_code, 'en');
      assert.equal(identity.rows[0].verification_status, 'verified');
      const current = await db.query(`SELECT id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (current.rowCount === 1
        && String(current.rows[0].source_record_id) === row.sourceRecordId
        && current.rows[0].source_variant_key === row.sourceVariantKey) {
        existingMappings += 1;
        continue;
      }
      if (current.rowCount) throw new Error(`Identity mapping drift during write ${row.cardIdentityId}`);
      const source = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`, [row.sourceRecordId,row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key became owned ${row.sourceRecordId}/${row.sourceVariantKey}`);
      const now = Date.now();
      const inserted = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at)
        VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) RETURNING id`,
        [row.mappingId,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,report.source.cardmarketCatalogueSha256,now]);
      insertedMappings += inserted.rowCount;
    }
    if (insertedMappings + existingMappings !== report.candidates.length) throw new Error('Final-46 persistence count mismatch');
    await db.query('COMMIT');
    return Object.freeze({ insertedMappings, existingMappings });
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
    report = await buildRelease(db);
    if (process.env.MAPPING_WRITE === 'true') {
      if (report.held.length) throw new Error(`Production write blocked: ${report.held.length} reviewed identities remain held`);
      const persistence = await persist(db, report);
      report = Object.freeze({ ...report, status: 'write_complete', productionWrites: true, persistence });
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-final-46-user-url-release.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, error: report.error, locatorDigest: report.locatorDigest, candidateDigest: report.candidateDigest, counts: report.counts, held: report.held, persistence: report.persistence }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
