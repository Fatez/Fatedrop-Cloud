function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

async function fetchJson(url, { fetchImpl, headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    throw new Error(`Catalogue source request failed (${status})`);
  }
  return response.json();
}

export function createTcgdexClient({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.tcgdex.net/v2',
  languageCode = 'en',
} = {}) {
  const language = requireText(languageCode, 'languageCode').toLowerCase();
  const base = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');

  return Object.freeze({
    async listSets() {
      const payload = await fetchJson(`${base}/${encodeURIComponent(language)}/sets`, { fetchImpl });
      if (!Array.isArray(payload)) throw new TypeError('TCGdex sets payload must be an array');
      return payload;
    },
    async getSet(id) {
      return fetchJson(`${base}/${encodeURIComponent(language)}/sets/${encodeURIComponent(requireText(id, 'setId'))}`, { fetchImpl });
    },
    async getCard(id) {
      return fetchJson(`${base}/${encodeURIComponent(language)}/cards/${encodeURIComponent(requireText(id, 'cardId'))}`, { fetchImpl });
    },
  });
}

export function createPokemonTcgClient({
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.pokemontcg.io/v2',
  apiKey = null,
  pageSize = 250,
} = {}) {
  const base = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');
  const safePageSize = Math.max(1, Math.min(250, Number(pageSize) || 250));
  const headers = apiKey ? { 'x-api-key': String(apiKey) } : {};

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
      const payload = await fetchJson(url.toString(), { fetchImpl, headers });
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
      const payload = await fetchJson(`${base}/sets/${encodeURIComponent(requireText(id, 'setId'))}`, { fetchImpl, headers });
      return payload?.data ?? payload;
    },
    async listCardsBySet(setId) {
      const safeSetId = requireText(setId, 'setId').replace(/"/g, '\\"');
      return paged('/cards', { q: `set.id:"${safeSetId}"` });
    },
    async getCard(id) {
      const payload = await fetchJson(`${base}/cards/${encodeURIComponent(requireText(id, 'cardId'))}`, { fetchImpl, headers });
      return payload?.data ?? payload;
    },
  });
}
