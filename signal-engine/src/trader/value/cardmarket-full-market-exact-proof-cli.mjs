import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { canonicalCollector, reviewedCardmarketUrl } from './cardmarket-url-first-rebuild.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-url-first-rebuild-source-2026-09-15.json');
const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-full.json');
const PROGRESS_OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-exact-proof-progress.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EDITIONED_SET_CODES = new Set(['base1','base2','base3','base4','base5','gym1','gym2','neo1','neo2','neo3','neo4']);

const positiveInt = (value, fallback, max) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const FALLBACK_CONCURRENCY = positiveInt(process.env.TCGGO_FALLBACK_CONCURRENCY, 12, 32);
const FALLBACK_DELAY_MS = positiveInt(process.env.TCGGO_FALLBACK_DELAY_MS, 150, 5000);
const PROGRESS_EVERY = positiveInt(process.env.TCGGO_PROGRESS_EVERY, 100, 5000);

const sourceVariantKey = (variantCode) => {
  if (variantCode === 'holo') return 'holo';
  if (variantCode === 'reverse-holo') return 'reverse';
  return 'normal';
};

const targetLane = (variantCode) => variantCode === 'holo' ? 'holo' : 'standard';
const sourceKey = (sourceRecordId, variantKey) => `${String(sourceRecordId)}|${String(variantKey)}`;

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(15000, retryAfter * 1000);
  return [750, 1500, 3000, 5000, 8000][Math.min(attempt, 4)];
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
          'user-agent': 'FateDrop-Cardmarket-Rebuild-Audit/1.0',
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
        hasTcgId: false,
        cardmarketIds: [],
      };
      if (attempt + 1 < attempts) await sleep([750, 1500, 3000, 5000, 8000][Math.min(attempt, 4)]);
    }
  }
  return last;
}

function chooseNetworkCandidate(identity, tcggo, productById, expectedExpansionId) {
  if (!tcggo?.ok || !tcggo?.hasTcgId) return { status: 'held', reason: 'TCGGO_EXACT_LOOKUP_FAILED', candidates: [] };
  const rawIds = [...new Set((tcggo.cardmarketIds || []).map(String))];
  if (!rawIds.length) return { status: 'held', reason: 'TCGGO_NO_CARDMARKET_ID', candidates: [] };

  let products = rawIds.map((id) => productById.get(id)).filter(Boolean);
  if (!products.length) return { status: 'held', reason: 'TCGGO_IDS_ABSENT_FROM_OFFICIAL_CARDMARKET_CATALOGUE', candidates: rawIds };

  const nameCompatible = products.filter((product) => rootProductNameMatches(identity.name, product.name));
  if (nameCompatible.length) products = nameCompatible;

  if (expectedExpansionId) {
    const inExpansion = products.filter((product) => String(product.sourceExpansionId ?? '') === String(expectedExpansionId));
    if (inExpansion.length) products = inExpansion;
  }

  const unique = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  if (unique.size !== 1) {
    return {
      status: 'held',
      reason: unique.size === 0 ? 'NO_VALID_CARDMARKET_PRODUCT_AFTER_FILTERS' : 'MULTIPLE_VALID_CARDMARKET_PRODUCTS',
      candidates: [...unique.keys()],
      rawIds,
    };
  }
  const [sourceRecordId, product] = [...unique.entries()][0];
  return { status: 'resolved', sourceRecordId, product, rawIds };
}

function priceEvidenceFor(identity, priceById, sourceRecordId) {
  const guide = priceById.get(String(sourceRecordId));
  const standard = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'standard'));
  const holo = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'holo'));
  if (identity.variant_code === 'reverse-holo') {
    return Object.freeze({
      standard,
      holo,
      targetLane: false,
      baseLaneOnlyForHolo: false,
      reverseOfferDerived: true,
    });
  }
  const lane = targetLane(identity.variant_code);
  return Object.freeze({
    standard,
    holo,
    targetLane: lane === 'holo' ? holo : standard,
    baseLaneOnlyForHolo: identity.variant_code === 'holo' && !holo && standard,
    reverseOfferDerived: false,
  });
}

function localProof(identity, cardById, setByCardId, productById) {
  const links = Array.isArray(identity.tcgdex_card_ids) ? identity.tcgdex_card_ids : [];
  if (links.length !== 1) return { status: 'held', reason: 'TCGDEX_LINK_COUNT_NOT_ONE' };
  const tcgId = links[0];
  const card = cardById.get(tcgId);
  const set = setByCardId.get(tcgId);
  if (!card || !set) return { status: 'held', reason: 'PINNED_TCGDEX_CARD_MISSING', tcgId };
  if (!rootProductNameMatches(identity.name, card.name)) return { status: 'held', reason: 'TCGDEX_CARD_NAME_MISMATCH', tcgId };
  if (canonicalCollector(identity.collector_number) !== canonicalCollector(card.localId)) {
    return { status: 'held', reason: 'TCGDEX_COLLECTOR_NUMBER_MISMATCH', tcgId };
  }

  const rootProductId = getRootCardmarketProductId(card);
  if (!rootProductId) return { status: 'held', reason: 'TCGDEX_ROOT_CARDMARKET_PRODUCT_ID_MISSING', tcgId };
  const sourceRecordId = String(rootProductId);
  const product = productById.get(sourceRecordId);
  if (!product) return { status: 'held', reason: 'TCGDEX_ROOT_PRODUCT_ABSENT_FROM_OFFICIAL_CARDMARKET_CATALOGUE', tcgId, sourceRecordId };
  if (!rootProductNameMatches(identity.name, product.name)) {
    return {
      status: 'held',
      reason: 'TCGDEX_ROOT_PRODUCT_NAME_MISMATCH',
      tcgId,
      sourceRecordId,
      cardmarketProductName: product.name,
    };
  }

  const expectedExpansionId = Number(set.cardmarketExpansionId);
  const hasExpectedExpansion = Number.isSafeInteger(expectedExpansionId) && expectedExpansionId > 0;
  const sameExpansion = hasExpectedExpansion && Number(product.sourceExpansionId) === expectedExpansionId;

  return {
    status: 'resolved',
    tcgId,
    sourceRecordId,
    product,
    expectedExpansionId: hasExpectedExpansion ? expectedExpansionId : null,
    expansionRelation: hasExpectedExpansion
      ? (sameExpansion ? 'main_set_expansion' : 'supplemental_cardmarket_expansion')
      : 'tcgdex_set_expansion_unavailable',
    method: 'pinned_tcgdex_exact_card_root_cardmarket_product',
  };
}

async function writeProgress({ counts, processed, total, workers, startedAt }) {
  const elapsedMs = Date.now() - startedAt;
  const payload = {
    status: processed >= total ? 'network_fallback_complete' : 'network_fallback_in_progress',
    productionWrites: false,
    processed,
    total,
    remaining: Math.max(0, total - processed),
    workers,
    elapsedMs,
    counts,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(PROGRESS_OUTPUT(), JSON.stringify(payload, null, 2));
  console.log(`[cardmarket-exact-proof] fallback ${processed}/${total} processed; resolved=${counts.networkFallbackResolved}; held=${counts.networkFallbackHeld}; workers=${workers}; elapsed=${Math.round(elapsedMs / 1000)}s`);
}

export async function build(db, { sources, repoEvidence, reviewedEvidence } = {}) {
  const reviewed = reviewedEvidence || JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (reviewed?.policy?.productionWrites !== false) throw new Error('Read-only URL evidence required');
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });

  const cardById = new Map();
  const setByCardId = new Map();
  for (const set of repo.sets) {
    for (const card of set.cards) {
      cardById.set(card.tcgdexCardId, card);
      setByCardId.set(card.tcgdexCardId, set);
    }
  }

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id AS card_identity_id,i.variant_code,p.name,p.collector_number,p.set_id,
      s.code AS set_code,s.name AS set_name,COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') AS classifier_state,
      ARRAY(SELECT DISTINCT t.source_record_id
        FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex'
        ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=p.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo','reverse-holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
    ORDER BY s.name,p.collector_number,p.name,i.variant_code,i.id`);

  const targets = identities.filter((row) => !EDITIONED_SET_CODES.has(String(row.set_code || '').toLowerCase()));

  const { rows: existingMappings } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const ownersBySourceKey = new Map();
  for (const row of existingMappings) {
    const key = sourceKey(row.source_record_id, row.source_variant_key);
    const bucket = ownersBySourceKey.get(key) || [];
    bucket.push(row.card_identity_id);
    ownersBySourceKey.set(key, bucket);
  }

  const counts = {
    targets: targets.length,
    localProofResolved: 0,
    localProofHeld: 0,
    localProofSupplementalExpansion: 0,
    networkFallbackTargets: 0,
    networkFallbackLookupTargets: 0,
    networkFallbackResolved: 0,
    networkFallbackHeld: 0,
    batchCollisionRows: 0,
    sourceOwnedConflict: 0,
    safeMappings: 0,
    exactProductResolved: 0,
    exactProductHeld: 0,
  };

  const resolved = [];
  const held = [];
  const fallback = [];

  for (const identity of targets) {
    const reviewedUrl = reviewedCardmarketUrl({
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
    }, reviewed.setSlugOverrides);

    const proof = localProof(identity, cardById, setByCardId, productById);
    if (proof.status !== 'resolved') {
      counts.localProofHeld += 1;
      fallback.push({ identity, reviewedUrl, localHold: proof });
      continue;
    }

    counts.localProofResolved += 1;
    counts.exactProductResolved += 1;
    if (proof.expansionRelation === 'supplemental_cardmarket_expansion') counts.localProofSupplementalExpansion += 1;
    const variantKey = sourceVariantKey(identity.variant_code);
    const foreignOwners = (ownersBySourceKey.get(sourceKey(proof.sourceRecordId, variantKey)) || [])
      .filter((owner) => owner !== identity.card_identity_id);
    resolved.push({
      cardIdentityId: identity.card_identity_id,
      setName: identity.set_name,
      setCode: identity.set_code,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      tcgId: proof.tcgId,
      reviewedCardmarketUrl: reviewedUrl,
      tcggo: null,
      sourceRecordId: proof.sourceRecordId,
      sourceVariantKey: variantKey,
      cardmarketProductName: proof.product.name,
      cardmarketExpansionId: String(proof.product.sourceExpansionId ?? ''),
      foreignOwners,
      priceEvidence: priceEvidenceFor(identity, priceById, proof.sourceRecordId),
      proof: {
        method: proof.method,
        expansionRelation: proof.expansionRelation,
        expectedExpansionId: proof.expectedExpansionId,
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
      },
    });
  }

  counts.networkFallbackTargets = fallback.length;

  const networkQueue = [];
  for (const entry of fallback) {
    const { identity, reviewedUrl, localHold } = entry;
    const tcgIds = Array.isArray(identity.tcgdex_card_ids) ? identity.tcgdex_card_ids : [];
    const tcgId = tcgIds.length === 1 ? tcgIds[0] : null;
    if (!tcgId) {
      counts.networkFallbackHeld += 1;
      counts.exactProductHeld += 1;
      held.push({
        card_identity_id: identity.card_identity_id,
        cardIdentityId: identity.card_identity_id,
        setName: identity.set_name,
        setCode: identity.set_code,
        name: identity.name,
        collectorNumber: identity.collector_number,
        variantCode: identity.variant_code,
        reviewedCardmarketUrl: reviewedUrl,
        reason: localHold.reason,
        localHold,
      });
      continue;
    }
    networkQueue.push({ ...entry, tcgId });
  }

  counts.networkFallbackLookupTargets = networkQueue.length;
  const workers = Math.min(FALLBACK_CONCURRENCY, Math.max(1, networkQueue.length));
  const startedAt = Date.now();
  console.log(JSON.stringify({
    stage: 'local_proof_complete',
    targets: counts.targets,
    localProofResolved: counts.localProofResolved,
    localProofHeld: counts.localProofHeld,
    localProofSupplementalExpansion: counts.localProofSupplementalExpansion,
    networkFallbackTargets: counts.networkFallbackTargets,
    networkFallbackLookupTargets: counts.networkFallbackLookupTargets,
    immediateHeldWithoutExactTcgId: counts.networkFallbackTargets - counts.networkFallbackLookupTargets,
    workers,
  }, null, 2));
  await writeProgress({ counts, processed: 0, total: networkQueue.length, workers, startedAt });

  let nextIndex = 0;
  let completed = 0;
  let lastProgressWritten = 0;

  const runOne = async (entry) => {
    const { identity, reviewedUrl, localHold, tcgId } = entry;
    const tcggo = await fetchTcggoExact(tcgId);
    const set = setByCardId.get(tcgId);
    const choice = chooseNetworkCandidate(identity, tcggo, productById, set?.cardmarketExpansionId || null);
    if (choice.status !== 'resolved') {
      counts.networkFallbackHeld += 1;
      counts.exactProductHeld += 1;
      held.push({
        card_identity_id: identity.card_identity_id,
        cardIdentityId: identity.card_identity_id,
        setName: identity.set_name,
        setCode: identity.set_code,
        name: identity.name,
        collectorNumber: identity.collector_number,
        variantCode: identity.variant_code,
        reviewedCardmarketUrl: reviewedUrl,
        tcggo: {
          url: tcggo?.url,
          status: tcggo?.status,
          hasTcgId: tcggo?.hasTcgId,
          cardmarketIds: tcggo?.cardmarketIds || [],
        },
        reason: choice.reason,
        candidates: choice.candidates,
        rawIds: choice.rawIds,
        localHold,
      });
      return;
    }

    counts.networkFallbackResolved += 1;
    counts.exactProductResolved += 1;
    const variantKey = sourceVariantKey(identity.variant_code);
    const foreignOwners = (ownersBySourceKey.get(sourceKey(choice.sourceRecordId, variantKey)) || [])
      .filter((owner) => owner !== identity.card_identity_id);
    resolved.push({
      cardIdentityId: identity.card_identity_id,
      setName: identity.set_name,
      setCode: identity.set_code,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      tcgId,
      reviewedCardmarketUrl: reviewedUrl,
      tcggo: { url: tcggo.url, status: tcggo.status, cardmarketIds: tcggo.cardmarketIds },
      sourceRecordId: choice.sourceRecordId,
      sourceVariantKey: variantKey,
      cardmarketProductName: choice.product.name,
      cardmarketExpansionId: String(choice.product.sourceExpansionId ?? ''),
      foreignOwners,
      priceEvidence: priceEvidenceFor(identity, priceById, choice.sourceRecordId),
      proof: {
        method: 'network_exact_tcgdex_id_to_cardmarket_product',
        localHold,
      },
    });
  };

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= networkQueue.length) return;
      await runOne(networkQueue[index]);
      completed += 1;
      if (completed === networkQueue.length || completed - lastProgressWritten >= PROGRESS_EVERY) {
        lastProgressWritten = completed;
        await writeProgress({ counts, processed: completed, total: networkQueue.length, workers, startedAt });
      }
      if (FALLBACK_DELAY_MS > 0) await sleep(FALLBACK_DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));

  const keyCounts = new Map();
  for (const row of resolved) {
    const key = sourceKey(row.sourceRecordId, row.sourceVariantKey);
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const collisionKeys = new Set([...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key));

  const safeMappings = [];
  const conflicts = [];
  for (const row of resolved) {
    const key = sourceKey(row.sourceRecordId, row.sourceVariantKey);
    if (collisionKeys.has(key)) {
      counts.batchCollisionRows += 1;
      conflicts.push({ ...row, reason: 'BATCH_SOURCE_COLLISION', sourceKey: key });
      continue;
    }
    if (row.foreignOwners.length) {
      counts.sourceOwnedConflict += 1;
      conflicts.push({ ...row, reason: 'SOURCE_KEY_ALREADY_OWNED' });
      continue;
    }
    counts.safeMappings += 1;
    safeMappings.push(row);
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    counts,
    source: {
      identity: 'exact FateDrop English identity -> exact pinned TCGdex card and collector number',
      localCrosswalk: 'pinned TCGdex explicit/root Cardmarket product ID -> official Cardmarket catalogue; supplemental Cardmarket expansions are accepted only when the exact TCGdex card/product/name proof closes',
      fallbackCrosswalk: 'public TCGGO exact TCGdex-ID search only when pinned local evidence cannot prove the product',
      price: 'Cardmarket public price guide for standard/holo; reverse is public-offer-derived later',
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
      networkFallbackConcurrency: FALLBACK_CONCURRENCY,
      networkFallbackDelayMs: FALLBACK_DELAY_MS,
    },
    collisionKeys: [...collisionKeys].sort(),
    safeMappings,
    conflicts,
    held,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    error: report.error,
    counts: report.counts,
    source: report.source,
    collisionKeys: report.collisionKeys,
    heldSample: report.held?.slice?.(0, 20),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
