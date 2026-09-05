const ECB_90_DAY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RATE_AGE_DAYS = 5;

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function isoDay(value) {
  const at = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(at) || at <= 0) throw new TypeError('FX timestamp must be a positive timestamp or ISO date');
  return new Date(at).toISOString().slice(0, 10);
}

function parseEcbRates(xml, quoteCurrencyCode = 'GBP') {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('ECB FX response was empty');
  const quote = upper(quoteCurrencyCode);
  const rates = new Map();
  const dayPattern = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g;
  let dayMatch;
  while ((dayMatch = dayPattern.exec(xml)) !== null) {
    const currencyPattern = new RegExp(`<Cube\\s+currency=['"]${quote}['"]\\s+rate=['"]([0-9]+(?:\\.[0-9]+)?)['"]\\s*\\/?>(?:<\\/Cube>)?`, 'i');
    const currencyMatch = dayMatch[2].match(currencyPattern);
    if (!currencyMatch) continue;
    const rate = Number(currencyMatch[1]);
    if (Number.isFinite(rate) && rate > 0) rates.set(dayMatch[1], rate);
  }
  if (!rates.size) throw new Error(`ECB FX response contained no ${quote} reference rates`);
  return rates;
}

export class FxRateUnavailableError extends Error {
  constructor(message, reason = 'FX_RATE_UNAVAILABLE') {
    super(message);
    this.name = 'FxRateUnavailableError';
    this.code = reason;
  }
}

export function createEcbFxClient({
  fetchImpl = globalThis.fetch,
  sourceUrl = ECB_90_DAY_URL,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxRateAgeDays = DEFAULT_MAX_RATE_AGE_DAYS,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  let cache = null;

  async function rateTable() {
    const currentNow = Number(now());
    if (cache && currentNow - cache.fetchedAt <= cacheTtlMs) return cache;
    let response;
    try {
      response = await fetchImpl(sourceUrl, {
        method: 'GET',
        headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' },
      });
    } catch (error) {
      throw new FxRateUnavailableError(`ECB FX request failed: ${error?.message || String(error)}`);
    }
    if (!response?.ok) {
      throw new FxRateUnavailableError(`ECB FX request failed (${response?.status || 'unknown'})`);
    }
    let xml;
    try {
      xml = await response.text();
    } catch (error) {
      throw new FxRateUnavailableError(`ECB FX response could not be read: ${error?.message || String(error)}`);
    }
    let rates;
    try {
      rates = parseEcbRates(xml, 'GBP');
    } catch (error) {
      throw new FxRateUnavailableError(error?.message || String(error), 'FX_SOURCE_INVALID');
    }
    cache = Object.freeze({ fetchedAt: currentNow, rates });
    return cache;
  }

  return Object.freeze({
    sourceName: 'ecb_reference_rates',
    sourceUrl,
    async getRate({ fromCurrencyCode = 'EUR', toCurrencyCode = 'GBP', at } = {}) {
      const from = upper(fromCurrencyCode);
      const to = upper(toCurrencyCode);
      if (!from || !to) throw new TypeError('FX currency codes are required');
      const requestedDay = isoDay(at);
      if (from === to) {
        return Object.freeze({
          sourceName: 'identity',
          sourceUrl: null,
          baseCurrencyCode: from,
          quoteCurrencyCode: to,
          rate: 1,
          rateDate: requestedDay,
          requestedDay,
          fetchedAt: Number(now()),
        });
      }
      if (from !== 'EUR' || to !== 'GBP') {
        throw new FxRateUnavailableError(`Unsupported FX pair ${from}/${to}`, 'FX_CURRENCY_UNSUPPORTED');
      }
      const table = await rateTable();
      const candidates = [...table.rates.keys()].filter((day) => day <= requestedDay).sort().reverse();
      const rateDate = candidates[0] || null;
      if (!rateDate) throw new FxRateUnavailableError(`No ECB GBP rate exists on or before ${requestedDay}`);
      const requestedStart = Date.parse(`${requestedDay}T00:00:00.000Z`);
      const rateStart = Date.parse(`${rateDate}T00:00:00.000Z`);
      const ageDays = Math.round((requestedStart - rateStart) / DAY_MS);
      if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > maxRateAgeDays) {
        throw new FxRateUnavailableError(`ECB GBP rate for ${requestedDay} is stale`, 'FX_RATE_STALE');
      }
      return Object.freeze({
        sourceName: 'ecb_reference_rates',
        sourceUrl,
        baseCurrencyCode: 'EUR',
        quoteCurrencyCode: 'GBP',
        rate: table.rates.get(rateDate),
        rateDate,
        requestedDay,
        fetchedAt: table.fetchedAt,
        ageDays,
      });
    },
  });
}

export const defaultEcbFxClient = createEcbFxClient();
export { ECB_90_DAY_URL, parseEcbRates };
