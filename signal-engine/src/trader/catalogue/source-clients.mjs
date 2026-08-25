function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(response, now = Date.now()) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(30_000, Math.max(0, at - now));
}

function defaultRetryDelay(attempt) {
  return Math.min(5_000, 250 * (2 ** attempt));
}

async function fetchJson(url, {
  fetchImpl,
  headers = {},
  retryAttempts = 4,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const attempts = Math.max(1, Math.min(6, Number(retryAttempts) || 4));
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      await sleepImpl(defaultRetryDelay(attempt));
      continue;
    }

    if (response?.ok) return response.json();

    const status = Number(response?.status) || 0;
    const error = new Error(`Catalogue source request failed (${status})`);
    error.status = status;
    lastError = error;
    if (!RETRYABLE_STATUSES.has(status) || attempt === attempts - 1) throw error;

    await sleepImpl(retryAfterMs(response) ?? defaultRetryDelay(attempt));
  }

  throw lastError || new Error('Catalogue source request failed');
}

export function createTcgdexClient({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.tcgdex.net/v2',
  languageCode = 'en',
  retryAttempts = 4,
  sleepImpl,
} = {}) {
  const language = requireText(languageCode, 'languageCode').toLowerCase();
  const base = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');
  const request = { fetchImpl, retryAttempts, sleepImpl };

  return Object.freeze({
    async listSets() {
      const payload = await fetchJson(`${base}/${encodeURIComponent(language)}/sets`, request);
      if (!Array.isArray(payload)) throw new TypeError('TCGdex sets payload must be an array');
      return payload;
    },
    async getSet(id) {
      return fetchJson(`${base}/${encodeURIComponent(language)}/sets/${encodeURIComponent(requireText(id, 'setId'))}`, request);
    },
    async getCard(id) {
      return fetchJson(`${base}/${encodeURIComponent(language)}/cards/${encodeURIComponent(requireText(id, 'cardId'))}`, request);
    },
  });
}

export function createPokemonTcgClient({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.pokemontcg.io/v2',
  apiKey = null,
  pageSize = 250,
  retryAttempts = 4,
  sleepImpl,
} = {}) {
  const base = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');
  const safePageSize = Math.max(1, Math.min(250, Number(pageSize) || 250));
  const headers = apiKey ? { 'x-api-key': String(apiKey) } : {};
  const request = { fetchImpl, headers, retryAttempts, sleepImpl };

  async function paged(path, params = {}) {
    const rows = [];
    let page = 1;
    while (true) {
      const url = new URL(`${base}${path}`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(safePageSize));
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
      const payload = await fetchJson(url.toString(), request);
      if (!Array.isArray(payload?.data)) throw new TypeError('Pokémon TCG API paged payload must contain data[]');
      rows.push(...payload.data);

      const count = Number(payload.count ?? payload.data.length);
      const totalCount = payload.totalCount == null ? null : Number(payload.totalCount);
      if (!Number.isFinite(count) || count <= 0) break;
      if (Number.isFinite(totalCount) && rows.length >= totalCount) break;
      if (payload.data.length < safePageSize) break;
      page += 1;
    }
    return rows;
  }

  return Object.freeze({
    async listSets() {
      return paged('/sets');
    },
    async getSet(id) {
      const payload = await fetchJson(`${base}/sets/${encodeURIComponent(requireText(id, 'setId'))}`, request);
      return payload?.data ?? payload;
    },
    async listCardsBySet(setId) {
      const safeSetId = requireText(setId, 'setId').replace(/"/g, '\\"');
      return paged('/cards', { q: `set.id:"${safeSetId}"` });
    },
    async getCard(id) {
      const payload = await fetchJson(`${base}/cards/${encodeURIComponent(requireText(id, 'cardId'))}`, request);
      return payload?.data ?? payload;
    },
  });
}
