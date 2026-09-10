import { withVersionedSourceSnapshots } from './source-snapshot-cache.mjs';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const ALLOWED_REGIONS = new Set(['WEST', 'JP', 'CN', 'KR']);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function retryAfterMs(response, now = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(30_000, Math.max(0, at - now));
}

function retryDelay(attempt) {
  return Math.min(5_000, 250 * (2 ** attempt));
}

function sourceError(url, status, code = null, cause = null) {
  const error = new Error(`PokemonTCGAPI catalogue request failed (${status}${code ? `:${code}` : ''}) for ${url}`);
  error.status = status;
  error.sourceUrl = url;
  error.sourceCode = code;
  if (cause) error.cause = cause;
  return error;
}

function assertApiUrl(value, base) {
  const url = new URL(value, base);
  const root = new URL(base);
  if (url.protocol !== 'https:' || url.origin !== root.origin || !url.pathname.startsWith('/v1/')) {
    throw new Error('PokemonTCGAPI pagination returned an untrusted next URL');
  }
  return url;
}

async function requestJson(url, { fetchImpl, apiKey, retryAttempts, sleepImpl }) {
  const attempts = Math.max(1, Math.min(6, Number(retryAttempts) || 4));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'X-Api-Key': apiKey },
      });
    } catch (cause) {
      lastError = sourceError(String(url), 'network', null, cause);
      if (attempt === attempts - 1) throw lastError;
      await sleepImpl(retryDelay(attempt));
      continue;
    }

    if (response?.ok) return response.json();
    const status = Number(response?.status) || 0;
    let code = null;
    try { code = (await response.json())?.error?.code || null; } catch {}
    lastError = sourceError(String(url), status, code);
    if (!RETRYABLE_STATUSES.has(status) || attempt === attempts - 1) throw lastError;
    await sleepImpl(retryAfterMs(response) ?? retryDelay(attempt));
  }
  throw lastError || sourceError(String(url), 'unknown');
}

function requirePage(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new TypeError('PokemonTCGAPI collection payload must contain data[]');
  }
  return payload;
}

export function createPokemonTcgApiRegionalClient({
  apiKey = process.env.PTCG_API_KEY,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.pokemontcgapi.com',
  retryAttempts = 4,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  snapshotDirectory = process.env.CATALOGUE_SOURCE_SNAPSHOT_DIR || null,
  snapshotVersion = process.env.CATALOGUE_PTCGAPI_SNAPSHOT_VERSION || null,
} = {}) {
  const key = requireText(apiKey, 'PTCG_API_KEY');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const base = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');
  const root = new URL(base);
  if (root.protocol !== 'https:') throw new TypeError('baseUrl must use https');
  const request = { fetchImpl, apiKey: key, retryAttempts, sleepImpl };

  async function collect(initialUrl) {
    const rows = [];
    const ids = new Set();
    let next = assertApiUrl(initialUrl, base);
    while (next) {
      const page = requirePage(await requestJson(next, request));
      for (const row of page.data) {
        const id = requireText(row?.id, 'catalogue row id');
        if (ids.has(id)) throw new Error(`PokemonTCGAPI pagination repeated row id: ${id}`);
        ids.add(id);
        rows.push(row);
      }
      const nextValue = page.links?.next;
      next = nextValue ? assertApiUrl(nextValue, base) : null;
    }
    return rows;
  }

  const client = Object.freeze({
    async listSets({ region = null } = {}) {
      const url = new URL('/v1/sets', base);
      url.searchParams.set('limit', '250');
      if (region != null) {
        const safeRegion = requireText(region, 'region').toUpperCase();
        if (!ALLOWED_REGIONS.has(safeRegion)) throw new TypeError('region must be WEST, JP, CN or KR');
        url.searchParams.set('region', safeRegion);
      }
      return collect(url);
    },
    async getSet(code) {
      const safeCode = requireText(code, 'setCode');
      const payload = await requestJson(assertApiUrl(`/v1/sets/${encodeURIComponent(safeCode)}`, base), request);
      return payload?.data ?? payload;
    },
    async listCardsBySet(code) {
      const safeCode = requireText(code, 'setCode');
      const url = new URL(`/v1/sets/${encodeURIComponent(safeCode)}/cards`, base);
      url.searchParams.set('limit', '250');
      return collect(url);
    },
    async getCard(id) {
      const safeId = requireText(id, 'cardId');
      const payload = await requestJson(assertApiUrl(`/v1/cards/${encodeURIComponent(safeId)}`, base), request);
      return payload?.data ?? payload;
    },
  });

  if (!snapshotDirectory && !snapshotVersion) return client;
  if (!snapshotDirectory || !snapshotVersion) {
    throw new Error('PokemonTCGAPI snapshots require both snapshotDirectory and snapshotVersion');
  }
  return withVersionedSourceSnapshots(client, {
    directory: snapshotDirectory,
    namespace: 'pokemontcgapi-regional',
    sourceVersion: snapshotVersion,
  });
}
