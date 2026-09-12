import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { build, tcgplayerFinishKeys } from './pokemontcg-finish-evidence-audit-cli.mjs';

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

async function fetchPokemonTcgFinishIndexResilient({ apiKey = process.env.POKEMONTCG_API_KEY } = {}) {
  const byId = new Map();
  const sourceRows = [];
  const pageSize = 100;
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
    if (!apiKey) await sleep(2_200);
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
      pageSize,
      retryAttempts: 8,
    }),
  });
}

async function main() {
  if (process.env.MAPPING_WRITE === 'true' || process.env.PRICE_WRITE === 'true') {
    throw new Error('PokemonTCG finish evidence audit is read-only');
  }

  validateProductionTarget(process.env.DATABASE_URL);
  const externalIndex = await fetchPokemonTcgFinishIndexResilient();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db, { externalIndex });
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
    console.log(JSON.stringify({
      status: report.status,
      counts: report.counts,
      reasons: report.reasons,
      byVariant: report.byVariant,
      byLaneBasis: report.byLaneBasis,
      source: report.source,
      error: report.error,
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
