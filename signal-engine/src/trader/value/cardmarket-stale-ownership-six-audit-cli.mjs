import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import {
  CARDMARKET_STALE_OWNERSHIP_SIX,
  CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST,
  stableCardmarketMappingId,
} from './cardmarket-stale-ownership-six.mjs';

const OUTPUT_PATH = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-stale-ownership-six-audit.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractCardmarketIds(html) {
  const ids = new Set();
  for (const re of [
    /"cardmarket_id"\s*:\s*(\d+)/gi,
    /\bCM\s+(\d{5,})\b/gi,
    /cardmarket[^\d]{0,40}(\d{5,})/gi,
  ]) {
    for (const match of html.matchAll(re)) ids.add(match[1]);
  }
  return [...ids];
}

async function fetchTcggoExact(tcgId, { attempts = 5 } = {}) {
  const url = new URL('https://www.tcggo.com/api-playground');
  url.searchParams.set('ep', 'cards.search');
  url.searchParams.set('game', 'pokemon');
  url.searchParams.set('q[tcgid]', tcgId);
  url.searchParams.set('q[sort]', 'relevance');
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'FateDrop-Stale-Ownership-Audit/1.0' },
        redirect: 'follow',
      });
      const html = await response.text();
      last = {
        url: url.toString(), status: response.status, ok: response.ok,
        hasTcgId: html.toLowerCase().includes(String(tcgId).toLowerCase()),
        cardmarketIds: extractCardmarketIds(html),
      };
      if (response.ok) return last;
      if (![403, 408, 425, 429, 500, 502, 503, 504].includes(response.status)) return last;
    } catch (error) {
      last = { url: url.toString(), status: 'error', ok: false, hasTcgId: false, cardmarketIds: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (attempt + 1 < attempts) await sleep([750, 1500, 3000, 5000, 8000][Math.min(attempt, 4)]);
  }
  return last;
}

async function loadIdentity(db, expected) {
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,i.collector_number,
      p.name,p.attributes->'artwork'->>'sourceRecordId' AS tcgdex_id,s.name AS set_name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    WHERE i.id=$1`, [expected.cardIdentityId]);
  const row = rows[0];
  if (!row) throw new Error(`Missing canonical identity ${expected.cardIdentityId}`);
  const actual = {
    cardIdentityId: row.id, variantCode: row.variant_code, languageCode: row.language_code,
    verificationStatus: row.verification_status, collectorNumber: String(row.collector_number),
    name: row.name, tcgdexId: row.tcgdex_id, setName: row.set_name,
  };
  const checks = [
    ['variantCode', expected.variantCode], ['languageCode', 'en'], ['verificationStatus', 'verified'],
    ['collectorNumber', expected.collectorNumber], ['name', expected.name], ['tcgdexId', expected.tcgdexId], ['setName', expected.setName],
  ];
  for (const [key, value] of checks) {
    if (String(actual[key]) !== String(value)) throw new Error(`Canonical identity drift ${expected.cardIdentityId}: ${key}=${actual[key]} expected ${value}`);
  }
  return actual;
}

async function exactEvidence(expected, productsById) {
  const tcggo = await fetchTcggoExact(expected.tcgdexId);
  if (!tcggo?.ok || !tcggo.hasTcgId) throw new Error(`TCGGO exact lookup failed for ${expected.tcgdexId}`);
  if (!tcggo.cardmarketIds.map(String).includes(String(expected.sourceRecordId))) {
    throw new Error(`Expected Cardmarket ${expected.sourceRecordId} absent from exact TCGGO ${expected.tcgdexId}: ${tcggo.cardmarketIds.join(',')}`);
  }
  const product = productsById.get(String(expected.sourceRecordId));
  if (!product) throw new Error(`Cardmarket product ${expected.sourceRecordId} missing from official catalogue`);
  if (String(product.sourceExpansionId ?? '') !== String(expected.expansionId)) {
    throw new Error(`Cardmarket expansion drift for ${expected.sourceRecordId}: ${product.sourceExpansionId}`);
  }
  if (String(product.name) !== expected.productName) {
    throw new Error(`Cardmarket product-name drift for ${expected.sourceRecordId}: ${product.name}`);
  }
  return { tcggo, cardmarket: { sourceRecordId: String(product.sourceRecordId), sourceExpansionId: String(product.sourceExpansionId), name: product.name } };
}

async function auditPair(db, pair, productsById) {
  const [targetIdentity, displacedIdentity] = await Promise.all([
    loadIdentity(db, pair.target), loadIdentity(db, pair.displaced),
  ]);
  const targetEvidence = await exactEvidence(pair.target, productsById);
  await sleep(300);
  const displacedEvidence = await exactEvidence(pair.displaced, productsById);

  const { rows: mappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND (id=$1 OR card_identity_id IN ($2,$3)
        OR (source_record_id IN ($4,$5) AND source_variant_key=$6))
    ORDER BY id`, [
    pair.staleMappingId, pair.target.cardIdentityId, pair.displaced.cardIdentityId,
    pair.target.sourceRecordId, pair.displaced.sourceRecordId, pair.sourceVariantKey,
  ]);

  const stale = mappings.find((row) => row.id === pair.staleMappingId);
  if (!stale
    || stale.card_identity_id !== pair.displaced.cardIdentityId
    || String(stale.source_record_id) !== String(pair.target.sourceRecordId)
    || stale.source_variant_key !== pair.sourceVariantKey) {
    throw new Error(`Expected stale ownership not present for ${pair.key}`);
  }
  if (mappings.some((row) => row.card_identity_id === pair.target.cardIdentityId)) {
    throw new Error(`Target already has Cardmarket mapping for ${pair.key}`);
  }
  if (mappings.some((row) => String(row.source_record_id) === String(pair.displaced.sourceRecordId) && row.source_variant_key === pair.sourceVariantKey)) {
    throw new Error(`Replacement source key already owned for ${pair.key}`);
  }

  const { rows: [obs] } = await db.query(`
    SELECT COUNT(*)::int AS observation_count,
      COUNT(*) FILTER (WHERE card_identity_id<>$2 OR source_record_id<>$3 OR source_variant_key<>$4)::int AS mismatched
    FROM fatedrop_market_observations WHERE card_source_mapping_id=$1`, [
    pair.staleMappingId, pair.displaced.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey,
  ]);
  if (Number(obs?.mismatched || 0) !== 0) throw new Error(`Attached observation drift for ${pair.key}`);

  return {
    key: pair.key,
    sourceVariantKey: pair.sourceVariantKey,
    staleMappingId: pair.staleMappingId,
    targetMappingId: stableCardmarketMappingId(pair.target.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey),
    displacedMappingId: stableCardmarketMappingId(pair.displaced.cardIdentityId, pair.displaced.sourceRecordId, pair.sourceVariantKey),
    observationCount: Number(obs?.observation_count || 0),
    target: { ...pair.target, identity: targetIdentity, evidence: targetEvidence },
    displaced: { ...pair.displaced, identity: displacedIdentity, evidence: displacedEvidence },
  };
}

export async function buildAudit(db) {
  const { artifact, products } = await fetchCardmarketPokemonSinglesCatalogue();
  const productsById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const pairs = [];
  for (let index = 0; index < CARDMARKET_STALE_OWNERSHIP_SIX.length; index += 1) {
    pairs.push(await auditPair(db, CARDMARKET_STALE_OWNERSHIP_SIX[index], productsById));
    if (index + 1 < CARDMARKET_STALE_OWNERSHIP_SIX.length) await sleep(300);
  }
  return {
    status: 'audit_complete', productionWrites: false,
    manifestDigest: CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST,
    count: pairs.length,
    cardmarketCatalogueSha256: artifact.sha256,
    pairs,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try { report = await buildAudit(db); }
  catch (error) { report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) }; process.exitCode = 1; }
  finally { db.release(); await pool.end(); }
  await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, count: report.count, manifestDigest: report.manifestDigest, pairs: report.pairs?.map((row) => ({ key: row.key, target: `${row.target.sourceRecordId}/${row.sourceVariantKey}`, displaced: `${row.displaced.sourceRecordId}/${row.sourceVariantKey}`, observationCount: row.observationCount })) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
