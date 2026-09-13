import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { build, tcgplayerFinishKeys } from './pokemontcg-finish-evidence-audit-cli.mjs';

const QUARANTINED_TCGDEX_SET_IDS = new Set(['base2', 'base3', 'base5', 'gym1', 'neo1', 'neo2', 'neo3', 'neo4']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJsonWithRetry(url, { apiKey, attempts = 8 } = {}) {
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
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 4_000 * attempt);
        await sleep(delay);
        continue;
      }
      if (!response.ok) throw new Error(`PokemonTCG API ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = Math.min(30_000, 2_000 * (2 ** (attempt - 1)));
        await sleep(delay);
      }
    }
  }
  throw lastError || new Error(`PokemonTCG API request failed for ${url}`);
}

function tcgdexSetIdFromCardId(cardId) {
  const value = String(cardId || '').trim();
  const split = value.lastIndexOf('-');
  return split > 0 ? value.slice(0, split) : null;
}

async function unresolvedTcgdexCardIds(db) {
  const { rows } = await db.query(`
    SELECT DISTINCT t.source_record_id AS tcgdex_card_id
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_source_mappings t
      ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND t.source_record_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
    ORDER BY t.source_record_id`);
  return rows.map((row) => String(row.tcgdex_card_id)).filter(Boolean);
}

async function fetchPokemonTcgFinishIndexForUnresolved(db, { apiKey = process.env.POKEMONTCG_API_KEY } = {}) {
  const requestedIds = await unresolvedTcgdexCardIds(db);
  const requested = new Set(requestedIds);
  const bySet = new Map();
  const ungroupedIds = [];

  for (const cardId of requestedIds) {
    const setId = tcgdexSetIdFromCardId(cardId);
    if (!setId) {
      ungroupedIds.push(cardId);
      continue;
    }
    if (QUARANTINED_TCGDEX_SET_IDS.has(setId)) continue;
    if (!bySet.has(setId)) bySet.set(setId, new Set());
    bySet.get(setId).add(cardId);
  }

  const byId = new Map();
  const sourceRows = [];
  const failedSets = [];
  const pageSize = 250;
  let requests = 0;
  let pages = 0;
  const setIds = [...bySet.keys()].sort();

  for (const setId of setIds) {
    const neededInSet = bySet.get(setId);
    let page = 1;
    let setFailed = false;

    while (true) {
      const url = new URL('https://api.pokemontcg.io/v2/cards');
      url.searchParams.set('q', `set.id:${setId}`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('select', 'id,name,number,rarity,tcgplayer');

      let payload;
      try {
        payload = await fetchJsonWithRetry(url, { apiKey });
      } catch (error) {
        failedSets.push({ setId, page, error: error instanceof Error ? error.message : String(error) });
        setFailed = true;
        break;
      }
      requests += 1;
      pages += 1;

      const cards = Array.isArray(payload?.data) ? payload.data : [];
      for (const card of cards) {
        if (!card?.id || typeof card.id !== 'string' || !neededInSet.has(card.id)) continue;
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

      const totalCount = Number(payload?.totalCount);
      if (cards.length < pageSize || (Number.isFinite(totalCount) && page * pageSize >= totalCount)) break;
      page += 1;
      if (!apiKey) await sleep(2_200);
    }

    if (!apiKey && !setFailed) await sleep(2_200);
  }

  const uniqueSourceRows = [...new Map(sourceRows.map((row) => [row.id, row])).values()];
  const digestRows = uniqueSourceRows
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => `${row.id}|${row.name}|${row.number}|${row.finishKeys.join(',')}|${row.tcgplayerUpdatedAt || ''}`);
  const sha256 = createHash('sha256').update(digestRows.join('\n')).digest('hex');
  const quarantinedRequested = requestedIds.filter((cardId) => QUARANTINED_TCGDEX_SET_IDS.has(tcgdexSetIdFromCardId(cardId))).length;

  return Object.freeze({
    byId,
    source: Object.freeze({
      provider: 'pokemontcg.io',
      evidenceOrigin: 'tcgplayer_price_finish_keys',
      fetchMode: 'unresolved_set_scoped',
      fetchedAt: new Date().toISOString(),
      requestedCards: requested.size,
      requestedSets: setIds.length,
      indexedCards: byId.size,
      unmatchedRequestedCards: requestedIds.filter((id) => !byId.has(id) && !QUARANTINED_TCGDEX_SET_IDS.has(tcgdexSetIdFromCardId(id))).length,
      quarantinedRequestedCards: quarantinedRequested,
      ungroupedRequestedCards: ungroupedIds.length,
      pages,
      requests,
      failedSets,
      sourceComplete: failedSets.length === 0 && ungroupedIds.length === 0,
      sha256,
      authenticated: Boolean(apiKey),
      pageSize,
      retryAttempts: 8,
    }),
  });
}

async function main() {
  let report = {
    status: 'blocked',
    productionWrites: false,
    activationAuthorized: false,
  };
  let db;
  let pool;

  try {
    if (process.env.MAPPING_WRITE === 'true' || process.env.PRICE_WRITE === 'true') {
      throw new Error('PokemonTCG finish evidence audit is read-only');
    }

    validateProductionTarget(process.env.DATABASE_URL);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    db = await pool.connect();

    const externalIndex = await fetchPokemonTcgFinishIndexForUnresolved(db);
    report = await build(db, { externalIndex });

    if (!externalIndex.source.sourceComplete) {
      report.status = 'audit_partial_external_source';
      report.activationAuthorized = false;
      report.externalSourceIncomplete = true;
      process.exitCode = 1;
    }
  } catch (error) {
    report = {
      status: 'blocked',
      productionWrites: false,
      activationAuthorized: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  } finally {
    if (db) db.release();
    if (pool) await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/pokemontcg-finish-evidence-audit.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      status: report.status,
      counts: report.counts,
      reasons: report.reasons,
      byVariant: report.byVariant,
      byLaneBasis: report.byLaneBasis,
      source: report.source,
      externalSourceIncomplete: report.externalSourceIncomplete,
      error: report.error,
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
