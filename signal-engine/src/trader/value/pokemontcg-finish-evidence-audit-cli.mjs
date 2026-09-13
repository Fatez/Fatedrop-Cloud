import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const QUARANTINED_TCGDEX_SET_IDS = new Set(['base2', 'base3', 'base5', 'gym1', 'neo1', 'neo2', 'neo3', 'neo4']);
const RECOGNISED_TCGPLAYER_FINISH_KEYS = new Set([
  'normal',
  'holofoil',
  'reverseHolofoil',
  '1stEditionNormal',
  '1stEditionHolofoil',
]);
const TARGET_FINISH_KEY = Object.freeze({ standard: 'normal', holo: 'holofoil' });
const SOURCE_VARIANT_KEY = Object.freeze({ standard: 'normal', holo: 'holo' });
const DIRECT_CARDMARKET_LANE = Object.freeze({ standard: 'standard', holo: 'holo' });

const key = (...parts) => parts.join('|');
const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normaliseCollectorNumber(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/(^|[^0-9])0+(?=\d)/g, '$1');
}

export function tcgplayerFinishKeys(card) {
  const prices = card?.tcgplayer?.prices;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return new Set();
  return new Set(Object.keys(prices).filter((finish) => RECOGNISED_TCGPLAYER_FINISH_KEYS.has(finish)));
}

export function assessPokemonTcgFinishEvidence(card, variantCode) {
  const targetFinishKey = TARGET_FINISH_KEY[variantCode];
  if (!targetFinishKey) return Object.freeze({ ok: false, reason: 'unsupported_target_finish', finishKeys: [] });
  const finishKeys = tcgplayerFinishKeys(card);
  if (!finishKeys.has(targetFinishKey)) {
    return Object.freeze({
      ok: false,
      reason: 'external_target_finish_absent',
      targetFinishKey,
      finishKeys: [...finishKeys].sort(),
    });
  }
  return Object.freeze({
    ok: true,
    reason: 'external_target_finish_proven',
    targetFinishKey,
    finishKeys: [...finishKeys].sort(),
  });
}

export function chooseCardmarketLane(priceRow, variantCode, finishEvidence) {
  const directLane = DIRECT_CARDMARKET_LANE[variantCode];
  if (!directLane) return Object.freeze({ ok: false, reason: 'unsupported_target_finish' });
  if (hasMeaningfulCardmarketLane(priceRow, directLane)) {
    return Object.freeze({ ok: true, providerLane: directLane, basis: 'direct_cardmarket_finish_lane' });
  }

  // Cardmarket carries inherently-holo products in its base lane. This fallback
  // is allowed only when an independent TCGplayer-derived source proves that the
  // card has a holofoil printing and does NOT expose a normal printing. That
  // prevents a base/non-foil lane from being silently reassigned to holo.
  if (
    variantCode === 'holo'
    && finishEvidence?.ok
    && finishEvidence.finishKeys.includes('holofoil')
    && !finishEvidence.finishKeys.includes('normal')
    && hasMeaningfulCardmarketLane(priceRow, 'standard')
    && !hasMeaningfulCardmarketLane(priceRow, 'holo')
  ) {
    return Object.freeze({ ok: true, providerLane: 'standard', basis: 'externally_proven_inherent_holo_base_lane' });
  }

  return Object.freeze({ ok: false, reason: 'no_unambiguous_cardmarket_price_lane' });
}

async function fetchJsonWithRetry(url, { apiKey, attempts = 5 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
          'user-agent': 'FateDrop/finish-evidence-audit',
        },
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`PokemonTCG API ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  throw lastError || new Error(`PokemonTCG API request failed for ${url}`);
}

export async function fetchPokemonTcgFinishIndex({ apiKey = process.env.POKEMONTCG_API_KEY } = {}) {
  const byId = new Map();
  const pageSize = 250;
  const sourceRows = [];
  let page = 1;
  let totalCount = null;
  let pages = 0;

  while (true) {
    const url = new URL('https://api.pokemontcg.io/v2/cards');
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('select', 'id,name,number,rarity,tcgplayer');
    const payload = await fetchJsonWithRetry(url, { apiKey });
    const cards = Array.isArray(payload?.data) ? payload.data : [];
    totalCount = Number.isFinite(Number(payload?.totalCount)) ? Number(payload.totalCount) : totalCount;
    pages += 1;

    for (const card of cards) {
      if (!card?.id || typeof card.id !== 'string') continue;
      const evidence = {
        id: card.id,
        name: String(card.name || ''),
        number: String(card.number || ''),
        rarity: card.rarity == null ? null : String(card.rarity),
        tcgplayerUpdatedAt: card?.tcgplayer?.updatedAt || null,
        finishKeys: [...tcgplayerFinishKeys(card)].sort(),
      };
      byId.set(card.id, { ...card, __finishEvidence: evidence });
      sourceRows.push(evidence);
    }

    if (cards.length < pageSize || (totalCount != null && byId.size >= totalCount)) break;
    page += 1;
    // Unauthenticated access is documented at 30 requests/minute. Stay below
    // that ceiling so the audit works without a new API credential.
    if (!apiKey) await sleep(2100);
  }

  const digestRows = sourceRows
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => `${row.id}|${row.name}|${row.number}|${row.finishKeys.join(',')}|${row.tcgplayerUpdatedAt || ''}`);
  const sha256 = createHash('sha256').update(digestRows.join('\n')).digest('hex');

  return Object.freeze({
    byId,
    source: Object.freeze({
      provider: 'pokemontcg.io',
      evidenceOrigin: 'tcgplayer_price_finish_keys',
      fetchedAt: new Date().toISOString(),
      pages,
      totalCount: totalCount ?? byId.size,
      indexedCards: byId.size,
      sha256,
      authenticated: Boolean(apiKey),
    }),
  });
}

export async function build(db, { repoEvidence, sources, externalIndex } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }, external] = await Promise.all([
    (sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue()),
    (sources?.guide ?? fetchCardmarketPokemonPriceGuide()),
    (externalIndex ? Promise.resolve(externalIndex) : fetchPokemonTcgFinishIndex()),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id, i.variant_code, i.set_id, p.name, p.collector_number,
           array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) FILTER (WHERE t.source_record_id IS NOT NULL) AS tcgdex_card_ids,
           array_agg(DISTINCT s.source_record_id ORDER BY s.source_record_id) FILTER (WHERE s.source_record_id IS NOT NULL) AS tcgdex_set_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    LEFT JOIN fatedrop_card_source_mappings t
      ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    LEFT JOIN fatedrop_card_set_source_mappings s
      ON s.set_id=i.set_id AND s.source_name='tcgdex'
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
    GROUP BY i.id,i.variant_code,i.set_id,p.name,p.collector_number
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id, source_record_id, source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const existingSource = new Map(existing.map((row) => [key(row.source_record_id, row.source_variant_key), row.card_identity_id]));

  const counts = {
    eligibleUnmappedNormalHolo: identities.length,
    singleTcgdexLink: 0,
    exactPokemonTcgId: 0,
    exactCollector: 0,
    exactExternalName: 0,
    targetFinishProven: 0,
    withRootCardmarketProductId: 0,
    cardmarketProductExists: 0,
    cardmarketNameCompatible: 0,
    directCardmarketLane: 0,
    inherentHoloBaseLane: 0,
    preBatchSafe: 0,
    safeExactMappings: 0,
    batchConflictKeys: 0,
    batchHeldCandidates: 0,
  };
  const reasons = {};
  const reason = (name) => { reasons[name] = (reasons[name] || 0) + 1; };
  const raw = [];
  const held = [];

  for (const identity of identities) {
    const tcgdexSetIds = Array.isArray(identity.tcgdex_set_ids) ? identity.tcgdex_set_ids : [];
    if (tcgdexSetIds.some((setId) => QUARANTINED_TCGDEX_SET_IDS.has(String(setId)))) {
      reason('intentional_first_edition_quarantine');
      held.push({ cardIdentityId: identity.id, reason: 'intentional_first_edition_quarantine' });
      continue;
    }

    const tcgdexCardIds = Array.isArray(identity.tcgdex_card_ids) ? identity.tcgdex_card_ids : [];
    if (tcgdexCardIds.length !== 1) {
      reason('multiple_or_missing_tcgdex_links');
      continue;
    }
    counts.singleTcgdexLink += 1;
    const tcgdexCardId = String(tcgdexCardIds[0]);
    const tcgdexCard = cardById.get(tcgdexCardId);
    if (!tcgdexCard) { reason('missing_pinned_tcgdex_card'); continue; }

    const externalCard = external.byId.get(tcgdexCardId);
    if (!externalCard) { reason('no_exact_pokemontcg_card_id'); continue; }
    counts.exactPokemonTcgId += 1;

    if (normaliseCollectorNumber(externalCard.number) !== normaliseCollectorNumber(identity.collector_number)) {
      reason('external_collector_number_conflict');
      continue;
    }
    counts.exactCollector += 1;

    if (!rootProductNameMatches(identity.name, externalCard.name)) {
      reason('external_name_conflict');
      continue;
    }
    counts.exactExternalName += 1;

    const finishEvidence = assessPokemonTcgFinishEvidence(externalCard, identity.variant_code);
    if (!finishEvidence.ok) {
      reason(finishEvidence.reason);
      held.push({
        cardIdentityId: identity.id,
        reason: finishEvidence.reason,
        tcgdexCardId,
        variantCode: identity.variant_code,
        externalFinishKeys: finishEvidence.finishKeys,
        externalRarity: externalCard.rarity || null,
      });
      continue;
    }
    counts.targetFinishProven += 1;

    const rootProductId = getRootCardmarketProductId(tcgdexCard);
    if (!rootProductId) { reason('no_root_cardmarket_product_id'); continue; }
    counts.withRootCardmarketProductId += 1;
    const sourceRecordId = String(rootProductId);
    const product = productById.get(sourceRecordId);
    if (!product) { reason('root_product_absent_from_official_catalogue'); continue; }
    counts.cardmarketProductExists += 1;
    if (!rootProductNameMatches(identity.name, product.name)) { reason('root_product_name_conflict'); continue; }
    counts.cardmarketNameCompatible += 1;

    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow) { reason('cardmarket_price_row_absent'); continue; }
    const lane = chooseCardmarketLane(priceRow, identity.variant_code, finishEvidence);
    if (!lane.ok) { reason(lane.reason); continue; }
    if (lane.basis === 'direct_cardmarket_finish_lane') counts.directCardmarketLane += 1;
    else if (lane.basis === 'externally_proven_inherent_holo_base_lane') counts.inherentHoloBaseLane += 1;

    const sourceVariantKey = SOURCE_VARIANT_KEY[identity.variant_code];
    const sourceKey = key(sourceRecordId, sourceVariantKey);
    const owner = existingSource.get(sourceKey);
    if (owner && owner !== identity.id) {
      reason('source_finish_owned_by_other_identity');
      held.push({
        cardIdentityId: identity.id,
        reason: 'source_finish_owned_by_other_identity',
        sourceRecordId,
        sourceVariantKey,
        existingCardIdentityId: owner,
      });
      continue;
    }

    raw.push({
      id: stableId('fdcardmap', [identity.id, 'cardmarket', sourceRecordId, sourceVariantKey]),
      cardIdentityId: identity.id,
      variantCode: identity.variant_code,
      name: identity.name,
      collectorNumber: identity.collector_number,
      tcgdexCardId,
      sourceRecordId,
      sourceVariantKey,
      providerPriceGuideLane: lane.providerLane,
      sourceVersion: catalogue.sha256,
      proof: {
        method: 'pokemontcg_tcgplayer_finish_key_plus_tcgdex_root_cardmarket_product',
        pokemonTcgEvidenceSha256: external.source.sha256,
        externalFinishKey: finishEvidence.targetFinishKey,
        externalFinishKeys: finishEvidence.finishKeys,
        externalRarity: externalCard.rarity || null,
        externalTcgplayerUpdatedAt: externalCard?.tcgplayer?.updatedAt || null,
        cardmarketProductName: product.name,
        cardmarketLaneBasis: lane.basis,
      },
    });
  }

  counts.preBatchSafe = raw.length;
  const sourceOwners = new Map();
  const badSourceKeys = new Set();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    if (sourceOwners.has(sourceKey) && sourceOwners.get(sourceKey) !== row.cardIdentityId) badSourceKeys.add(sourceKey);
    else sourceOwners.set(sourceKey, row.cardIdentityId);
  }
  const candidates = raw.filter((row) => !badSourceKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  counts.batchConflictKeys = badSourceKeys.size;
  counts.batchHeldCandidates = raw.length - candidates.length;
  counts.safeExactMappings = candidates.length;
  if (counts.batchHeldCandidates) reason('batch_source_collision');

  const byVariant = {};
  const byLaneBasis = {};
  for (const row of candidates) {
    byVariant[row.variantCode] = (byVariant[row.variantCode] || 0) + 1;
    byLaneBasis[row.proof.cardmarketLaneBasis] = (byLaneBasis[row.proof.cardmarketLaneBasis] || 0) + 1;
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    activationAuthorized: false,
    source: {
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      pokemonTcg: external.source,
    },
    policy: {
      exactPokemonTcgCardIdRequired: true,
      exactCollectorRequired: true,
      exactNameRequired: true,
      tcgplayerFinishKeyUsedAsEvidenceOnly: true,
      tcgplayerPricesNeverPersisted: true,
      cardmarketRemainsPriceProvider: true,
      firstEditionKeysIgnored: true,
      firstEditionSetsQuarantined: [...QUARANTINED_TCGDEX_SET_IDS].sort(),
      reverseExcluded: true,
      noDefaultNormalFallback: true,
      rarityNeverAuthorizesWrite: true,
      inherentHoloBaseLaneRequiresHolofoilAndNoNormalExternalKey: true,
      ownershipFailClosed: true,
    },
    counts,
    reasons,
    byVariant,
    byLaneBasis,
    candidates,
    held,
  };
}

async function main() {
  if (process.env.MAPPING_WRITE === 'true' || process.env.PRICE_WRITE === 'true') {
    throw new Error('PokemonTCG finish evidence audit is read-only');
  }
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
  } catch (error) {
    report = {
      status: 'blocked',
      productionWrites: false,
      activationAuthorized: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/pokemontcg-finish-evidence-audit.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts, reasons: report.reasons, byVariant: report.byVariant, byLaneBasis: report.byLaneBasis, source: report.source }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
