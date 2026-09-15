import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const INPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-full.json');
const OUTPUT = INPUT;
const DIAGNOSTIC = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-collision-network-recovery.json');
const CONCURRENCY = Math.max(1, Math.min(32, Number(process.env.TCGGO_COLLISION_CONCURRENCY || 24)));
const DELAY_MS = Math.max(0, Math.min(5000, Number(process.env.TCGGO_COLLISION_DELAY_MS || 75)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sourceKey = (row) => `${String(row.sourceRecordId)}|${String(row.sourceVariantKey)}`;

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(15000, retryAfter * 1000);
  return [600, 1200, 2400, 4000, 7000][Math.min(attempt, 4)];
}

function extractCardmarketIds(html) {
  const ids = new Set();
  for (const re of [
    /\"cardmarket_id\"\s*:\s*(\d+)/gi,
    /\bCM\s+(\d{5,})\b/gi,
    /cardmarket[^\d]{0,40}(\d{5,})/gi,
  ]) {
    for (const match of String(html || '').matchAll(re)) ids.add(match[1]);
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
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'FateDrop-Cardmarket-Collision-Recovery/1.0',
        },
        redirect: 'follow',
      });
      const html = await response.text();
      last = {
        url: url.toString(),
        status: response.status,
        ok: response.ok,
        hasTcgId: html.toLowerCase().includes(String(tcgId).toLowerCase()),
        cardmarketIds: extractCardmarketIds(html),
      };
      if (response.ok) return last;
      if (![403, 408, 425, 429, 500, 502, 503, 504].includes(response.status)) return last;
      if (attempt + 1 < attempts) await sleep(retryDelay(response, attempt));
    } catch (error) {
      last = {
        url: url.toString(),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        hasTcgId: false,
        cardmarketIds: [],
      };
      if (attempt + 1 < attempts) await sleep([600, 1200, 2400, 4000, 7000][Math.min(attempt, 4)]);
    }
  }
  return last;
}

function chooseCandidate(row, lookup, productById) {
  if (!lookup?.ok || !lookup?.hasTcgId) return { status: 'held', reason: 'TCGGO_EXACT_LOOKUP_FAILED' };
  const rawIds = [...new Set((lookup.cardmarketIds || []).map(String))];
  if (!rawIds.length) return { status: 'held', reason: 'TCGGO_NO_CARDMARKET_ID' };
  let products = rawIds.map((id) => productById.get(id)).filter(Boolean);
  if (!products.length) return { status: 'held', reason: 'TCGGO_IDS_ABSENT_FROM_OFFICIAL_CARDMARKET_CATALOGUE', rawIds };

  const compatible = products.filter((product) => rootProductNameMatches(row.name, product.name));
  if (compatible.length) products = compatible;

  const expectedExpansionId = String(row.cardmarketExpansionId || '').trim();
  if (expectedExpansionId) {
    const sameExpansion = products.filter((product) => String(product.sourceExpansionId || '') === expectedExpansionId);
    if (sameExpansion.length) products = sameExpansion;
  }

  const unique = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  if (unique.size !== 1) {
    return {
      status: 'held',
      reason: unique.size ? 'MULTIPLE_VALID_CARDMARKET_PRODUCTS' : 'NO_VALID_CARDMARKET_PRODUCT_AFTER_FILTERS',
      candidates: [...unique.keys()],
      rawIds,
    };
  }
  const [sourceRecordId, product] = [...unique.entries()][0];
  return { status: 'resolved', sourceRecordId, product, rawIds };
}

function priceEvidenceFor(row, priceById, sourceRecordId) {
  const guide = priceById.get(String(sourceRecordId));
  const standard = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'standard'));
  const holo = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'holo'));
  if (row.variantCode === 'reverse-holo') {
    return { standard, holo, targetLane: false, baseLaneOnlyForHolo: false, reverseOfferDerived: true };
  }
  if (row.variantCode === 'holo') {
    return { standard, holo, targetLane: holo, baseLaneOnlyForHolo: !holo && standard, reverseOfferDerived: false };
  }
  return { standard, holo, targetLane: standard, baseLaneOnlyForHolo: false, reverseOfferDerived: false };
}

async function mapConcurrent(rows, worker) {
  const output = new Array(rows.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      output[index] = await worker(rows[index], index);
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length || 1) }, run));
  return output;
}

export async function recover(db, input) {
  if (input?.status !== 'audit_complete' || input?.productionWrites !== false) {
    throw new Error('Completed read-only exact-proof report required');
  }

  const collisionRows = (input.conflicts || []).filter((row) => row.reason === 'BATCH_SOURCE_COLLISION');
  const untouchedConflicts = (input.conflicts || []).filter((row) => row.reason !== 'BATCH_SOURCE_COLLISION');
  const [{ products }, { snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  let processed = 0;
  const attempts = await mapConcurrent(collisionRows, async (row) => {
    const lookup = await fetchTcggoExact(row.tcgId);
    const choice = chooseCandidate(row, lookup, productById);
    processed += 1;
    if (processed % 100 === 0 || processed === collisionRows.length) {
      console.log(`[cardmarket-collision-recovery] ${processed}/${collisionRows.length}`);
    }
    if (choice.status !== 'resolved') return { row, lookup, choice };
    const product = choice.product;
    const recovered = {
      ...row,
      tcggo: lookup,
      sourceRecordId: String(choice.sourceRecordId),
      cardmarketProductName: product.name,
      cardmarketExpansionId: String(product.sourceExpansionId || ''),
      priceEvidence: priceEvidenceFor(row, priceById, choice.sourceRecordId),
      proof: {
        method: 'tcggo_exact_collision_recovery',
        priorSourceRecordId: String(row.sourceRecordId),
        networkCardmarketIds: choice.rawIds,
        expectedExpansionId: String(row.cardmarketExpansionId || '') || null,
        recoveredExpansionId: String(product.sourceExpansionId || '') || null,
      },
    };
    delete recovered.reason;
    delete recovered.sourceKey;
    return { row, lookup, choice, recovered };
  });

  const provisional = attempts.filter((item) => item.recovered).map((item) => item.recovered);
  const fixedRows = [...(input.safeMappings || []), ...untouchedConflicts];
  const fixedOwners = new Map();
  for (const row of fixedRows) {
    const key = sourceKey(row);
    const bucket = fixedOwners.get(key) || [];
    bucket.push(row.cardIdentityId);
    fixedOwners.set(key, bucket);
  }
  const provisionalByKey = new Map();
  for (const row of provisional) {
    const key = sourceKey(row);
    const bucket = provisionalByKey.get(key) || [];
    bucket.push(row);
    provisionalByKey.set(key, bucket);
  }

  const candidateKeys = [...new Set(provisional.map(sourceKey))];
  const { rows: currentOwners } = candidateKeys.length ? await db.query(`
    SELECT source_record_id,source_variant_key,card_identity_id
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND (source_record_id || '|' || source_variant_key) = ANY($1::text[])
    ORDER BY source_record_id,source_variant_key,card_identity_id`, [candidateKeys]) : { rows: [] };
  const ownersByKey = new Map();
  for (const owner of currentOwners) {
    const key = `${String(owner.source_record_id)}|${String(owner.source_variant_key)}`;
    const bucket = ownersByKey.get(key) || [];
    bucket.push(owner.card_identity_id);
    ownersByKey.set(key, bucket);
  }

  const safeMappings = [...(input.safeMappings || [])];
  const conflicts = [...untouchedConflicts];
  const recoveredIdentityIds = new Set();
  const unresolved = [];

  for (const attempt of attempts) {
    if (!attempt.recovered) {
      unresolved.push({
        cardIdentityId: attempt.row.cardIdentityId,
        tcgId: attempt.row.tcgId,
        reason: attempt.choice.reason,
        candidates: attempt.choice.candidates || attempt.choice.rawIds || [],
        status: attempt.lookup?.status ?? null,
      });
      conflicts.push(attempt.row);
      continue;
    }

    const recovered = attempt.recovered;
    const key = sourceKey(recovered);
    const otherProvisional = (provisionalByKey.get(key) || []).filter((row) => row.cardIdentityId !== recovered.cardIdentityId);
    const fixed = (fixedOwners.get(key) || []).filter((identityId) => identityId !== recovered.cardIdentityId);
    if (otherProvisional.length || fixed.length) {
      conflicts.push({
        ...recovered,
        reason: 'BATCH_SOURCE_COLLISION',
        sourceKey: key,
      });
      continue;
    }

    const foreignOwners = [...new Set((ownersByKey.get(key) || []).filter((identityId) => identityId !== recovered.cardIdentityId))];
    const finalRow = { ...recovered, foreignOwners };
    recoveredIdentityIds.add(recovered.cardIdentityId);
    if (foreignOwners.length) {
      conflicts.push({ ...finalRow, reason: 'SOURCE_OWNED_CONFLICT', sourceKey: key });
    } else {
      safeMappings.push(finalRow);
    }
  }

  const allDesired = [...safeMappings, ...conflicts];
  const collisionGroups = new Map();
  for (const row of allDesired) {
    const key = sourceKey(row);
    const bucket = collisionGroups.get(key) || [];
    bucket.push(row.cardIdentityId);
    collisionGroups.set(key, bucket);
  }
  const collisionKeys = [...collisionGroups.entries()]
    .filter(([, identities]) => new Set(identities).size > 1)
    .map(([key]) => key)
    .sort();

  const report = {
    ...input,
    counts: {
      ...input.counts,
      collisionRecoveryTargets: collisionRows.length,
      collisionRecoveryResolved: recoveredIdentityIds.size,
      collisionRecoveryUnresolved: collisionRows.length - recoveredIdentityIds.size,
      batchCollisionRowsAfterRecovery: [...safeMappings, ...conflicts].filter((row) => collisionKeys.includes(sourceKey(row))).length,
      safeMappings: safeMappings.length,
    },
    collisionKeys,
    safeMappings,
    conflicts,
    source: {
      ...input.source,
      collisionRecovery: {
        method: 'exact TCGdex card id -> TCGGO exact lookup -> official Cardmarket catalogue -> exact finish lane',
        networkFallbackOnly: true,
      },
    },
  };

  const diagnostic = {
    status: 'audit_complete',
    productionWrites: false,
    counts: {
      targets: collisionRows.length,
      exactNetworkResolved: provisional.length,
      promotedUnique: recoveredIdentityIds.size,
      unresolved: unresolved.length,
      remainingCollisionKeys: collisionKeys.length,
      safeMappingsAfter: safeMappings.length,
      conflictsAfter: conflicts.length,
    },
    unresolved,
  };
  return { report, diagnostic };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const input = JSON.parse(await readFile(INPUT(), 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  try {
    const { report, diagnostic } = await recover(db, input);
    await writeFile(OUTPUT(), JSON.stringify(report, null, 2));
    await writeFile(DIAGNOSTIC(), JSON.stringify(diagnostic, null, 2));
    console.log(JSON.stringify(diagnostic.counts, null, 2));
  } finally {
    db.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
