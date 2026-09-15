import { createHash } from 'node:crypto';
import { load } from 'cheerio';

import {
  makeMarketIngestRunId,
  normaliseMarketIngestRejection,
  normaliseMarketIngestRun,
  normaliseMarketObservationCandidate,
} from './market-observation.mjs';
import { persistMarketEvidenceBatch } from './market-store.mjs';
import { assertFatePriceProviderApproved } from './provider-policy.mjs';

const CARDMARKET_SOURCE_NAME = 'cardmarket';
const REVERSE_VARIANT_KEY = 'reverse';
const REVERSE_SEGMENT_KEY = 'reverse';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MIN_OFFERS = 3;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_REQUEST_DELAY_MS = 300;
const ALLOWED_HOSTS = new Set(['cardmarket.com', 'www.cardmarket.com']);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireStore(store) {
  if (!store || typeof store.pool !== 'function') throw new TypeError('Postgres Fate Value store is required');
  return store;
}

function validateCardmarketProductUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new TypeError('Cardmarket product URL must use HTTPS');
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new TypeError(`Unsupported Cardmarket host: ${url.hostname}`);
  if (!/^\/en\/Pokemon\/Products\/Singles\//i.test(url.pathname)) {
    throw new TypeError(`Unsupported Cardmarket product path: ${url.pathname}`);
  }
  if (url.username || url.password) throw new TypeError('Cardmarket product URL must not contain credentials');
  return url;
}

export function buildCardmarketReversePublicUrl(productUrl) {
  const url = validateCardmarketProductUrl(productUrl);
  url.hash = '';
  url.search = '';
  url.searchParams.set('language', '1');
  url.searchParams.set('isReverseHolo', 'Y');
  return url.toString();
}

function parsePriceText(value) {
  const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
  if (!/[0-9]/.test(raw)) return null;
  const currencyCode = /£|\bGBP\b/i.test(raw) ? 'GBP' : /€|\bEUR\b/i.test(raw) ? 'EUR' : null;
  if (!currencyCode) return null;
  const token = raw.match(/[0-9][0-9.,\s]*/)?.[0]?.replace(/\s/g, '') || '';
  if (!token) return null;
  let normalized = token;
  if (token.includes(',') && token.includes('.')) {
    normalized = token.lastIndexOf(',') > token.lastIndexOf('.')
      ? token.replace(/\./g, '').replace(',', '.')
      : token.replace(/,/g, '');
  } else if (token.includes(',')) {
    normalized = token.replace(/\./g, '').replace(',', '.');
  }
  const price = Number(normalized);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Object.freeze({ price, currencyCode });
}

const LANGUAGE_NAMES = Object.freeze([
  'English', 'French', 'German', 'Spanish', 'Italian', 'Japanese', 'Portuguese', 'Russian',
  'Korean', 'Dutch', 'Polish', 'Czech', 'Hungarian', 'S-Chinese', 'T-Chinese', 'Indonesian', 'Thai',
]);

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function languageFromRow($, row) {
  const labels = [];
  $(row).find('.product-attributes .icon').each((_, icon) => {
    for (const attribute of ['aria-label', 'data-bs-original-title', 'data-original-title', 'title', 'onmouseover']) {
      const value = $(icon).attr(attribute);
      if (value) labels.push(stripHtml(value));
    }
  });
  for (const label of labels) {
    const found = LANGUAGE_NAMES.find((language) => label === language || label.includes(language));
    if (found) return found;
  }
  // Cardmarket's English-only public filter omits a separate language label in
  // some layouts. When no contradictory language icon exists, English is the
  // safe default for a request explicitly scoped with language=1.
  return 'English';
}

const CONDITION_NAMES = Object.freeze([
  ['MT', /\bMint\b/i],
  ['NM', /\bNear Mint\b/i],
  ['EX', /\bExcellent\b/i],
  ['GD', /\bGood\b/i],
  ['LP', /\bLight(?:ly)? Played\b/i],
  ['PL', /\bPlayed\b/i],
  ['PO', /\bPoor\b/i],
]);

function conditionFromRow($, row) {
  const candidates = [];
  for (const selector of ['.article-condition', '.condition-container', '.col-condition', '[data-condition]']) {
    $(row).find(selector).each((_, node) => {
      candidates.push($(node).attr('data-condition') || '');
      candidates.push($(node).text() || '');
      for (const attr of ['aria-label', 'data-bs-original-title', 'data-original-title', 'title']) {
        candidates.push($(node).attr(attr) || '');
      }
    });
  }
  $(row).find('.product-attributes .icon').each((_, node) => {
    for (const attr of ['aria-label', 'data-bs-original-title', 'data-original-title', 'title']) {
      candidates.push($(node).attr(attr) || '');
    }
  });
  const text = candidates.map(stripHtml).filter(Boolean).join(' | ');
  for (const [code, pattern] of CONDITION_NAMES) if (pattern.test(text)) return code;
  const explicitCode = text.match(/(?:^|\s|[|(/])(?:Condition\s*:?[\s]*)?(MT|NM|EX|GD|LP|PL|PO)(?=$|\s|[|)/])/i)?.[1];
  return explicitCode ? explicitCode.toUpperCase() : 'unspecified';
}

function articleIdFromRow($, row) {
  for (const attr of ['data-id-article', 'data-article-id', 'data-idarticle', 'id']) {
    const value = String($(row).attr(attr) || '').trim();
    const match = value.match(/(?:article(?:row)?[-_]?|^)(\d{4,})$/i) || value.match(/(\d{4,})/);
    if (match) return match[1];
  }
  const nested = $(row).find('[data-id-article],[data-article-id],[data-idarticle]').first();
  if (nested.length) {
    for (const attr of ['data-id-article', 'data-article-id', 'data-idarticle']) {
      const value = String(nested.attr(attr) || '').trim();
      if (/^\d+$/.test(value)) return value;
    }
  }
  return null;
}

function rowHasExcludedModification($, row) {
  const labels = [];
  $(row).find('.product-attributes .icon').each((_, node) => {
    for (const attr of ['aria-label', 'data-bs-original-title', 'data-original-title', 'title']) {
      const value = $(node).attr(attr);
      if (value) labels.push(stripHtml(value));
    }
  });
  return labels.some((label) => /\bSigned\b|\bAltered\b/i.test(label));
}

export function parseCardmarketReverseOffersHtml(html, {
  sourceRecordId,
  productUrl,
  filteredUrl = buildCardmarketReversePublicUrl(productUrl),
} = {}) {
  const productId = String(sourceRecordId || '').trim();
  if (!productId) throw new TypeError('sourceRecordId is required');
  const expectedUrl = buildCardmarketReversePublicUrl(productUrl);
  if (filteredUrl !== expectedUrl) throw new Error('Reverse listing URL drifted from the certified product URL');

  const $ = load(String(html || ''));
  const pageText = $.root().text().replace(/\s+/g, ' ');
  if (!/Reverse Holo|Only Reverse\?/i.test(pageText)) {
    throw new Error('Cardmarket product page did not expose reverse-holo filtering evidence');
  }

  let rows = $('#table .table-body .article-row');
  if (!rows.length) rows = $('.article-table .table-body .article-row');
  if (!rows.length) rows = $('.article-row');

  const offers = [];
  rows.each((_, row) => {
    if (rowHasExcludedModification($, row)) return;
    const language = languageFromRow($, row);
    if (language !== 'English') return;
    const priceText = $(row).find('.col-offer .price-container .color-primary').first().text()
      || $(row).find('.mobile-offer-container .color-primary').first().text()
      || $(row).find('.price-container .color-primary').first().text();
    const parsedPrice = parsePriceText(priceText);
    if (!parsedPrice) return;
    offers.push(Object.freeze({
      articleId: articleIdFromRow($, row),
      sourceRecordId: productId,
      language: 'English',
      condition: conditionFromRow($, row),
      isReverseHolo: true,
      currencyCode: parsedPrice.currencyCode,
      price: parsedPrice.price,
    }));
  });

  return Object.freeze({
    sourceRecordId: productId,
    productUrl: validateCardmarketProductUrl(productUrl).toString().split('?')[0].split('#')[0],
    filteredUrl,
    rowCount: rows.length,
    offers: Object.freeze(offers),
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summariseReverseOfferMarket(offers, { minOffers = DEFAULT_MIN_OFFERS } = {}) {
  const byCurrency = new Map();
  for (const offer of offers || []) {
    if (!Number.isFinite(Number(offer?.price)) || Number(offer.price) <= 0) continue;
    const currency = String(offer.currencyCode || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const bucket = byCurrency.get(currency) || [];
    bucket.push(offer);
    byCurrency.set(currency, bucket);
  }
  if (!byCurrency.size) return Object.freeze({ status: 'no_qualifying_offers', qualifyingOffers: 0 });

  const rankedCurrencies = [...byCurrency.entries()].sort((a, b) => {
    if (a[0] === 'EUR' && b[0] !== 'EUR') return -1;
    if (b[0] === 'EUR' && a[0] !== 'EUR') return 1;
    return b[1].length - a[1].length;
  });
  const [currencyCode, selected] = rankedCurrencies[0];
  if (selected.length < minOffers) {
    return Object.freeze({
      status: 'insufficient_offers',
      currencyCode,
      qualifyingOffers: selected.length,
      discardedOtherCurrencyOffers: [...byCurrency.values()].reduce((sum, rows) => sum + rows.length, 0) - selected.length,
    });
  }

  const prices = selected.map((offer) => Number(offer.price)).sort((a, b) => a - b);
  const trimCount = prices.length >= 10 ? Math.floor(prices.length * 0.1) : 0;
  const trimmed = trimCount > 0 ? prices.slice(trimCount, prices.length - trimCount) : prices;
  const marketPrice = median(trimmed);
  const confidence = selected.length >= 20 ? 'high' : selected.length >= 8 ? 'medium' : 'low';

  return Object.freeze({
    status: 'priced',
    currencyCode,
    marketPrice,
    lowPrice: prices[0],
    medianPrice: median(prices),
    q25: quantile(prices, 0.25),
    q75: quantile(prices, 0.75),
    qualifyingOffers: selected.length,
    trimmedOffers: trimmed.length,
    trimCountPerTail: trimCount,
    confidence,
    discardedOtherCurrencyOffers: [...byCurrency.values()].reduce((sum, rows) => sum + rows.length, 0) - selected.length,
    offers: Object.freeze(selected),
  });
}

async function readLimitedHtml(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Cardmarket product page exceeds byte limit (${declared} > ${maxBytes})`);
  const text = await response.text();
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maxBytes) throw new Error(`Cardmarket product page exceeds byte limit (${size} > ${maxBytes})`);
  if (/cf-chl-|Cloudflare|Attention Required|captcha/i.test(text) && !/article-row/i.test(text)) {
    throw new Error('Cardmarket product page returned an access challenge instead of listings');
  }
  return text;
}

export async function fetchCardmarketReversePublicPage(productUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl function is required');
  assertFatePriceProviderApproved('cardmarket-public-product-page');
  const filteredUrl = buildCardmarketReversePublicUrl(productUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(filteredUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-GB,en;q=0.9',
        'user-agent': 'FateDrop-Market-Certifier/1.0',
      },
    });
    const finalUrl = validateCardmarketProductUrl(response?.url || filteredUrl);
    if (!response?.ok) {
      const error = new Error(`Cardmarket reverse product request failed with HTTP ${response?.status ?? 'unknown'}`);
      error.status = response?.status ?? null;
      error.retryAfter = response?.headers?.get?.('retry-after') || null;
      throw error;
    }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error(`Cardmarket reverse product returned unsupported content type: ${contentType}`);
    }
    return Object.freeze({
      filteredUrl,
      finalUrl: finalUrl.toString(),
      html: await readLimitedHtml(response, maxBytes),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(productUrl, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchCardmarketReversePublicPage(productUrl, options);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (![429, 500, 502, 503, 504].includes(status) || attempt === 3) throw error;
      const retrySeconds = Math.max(1, Number(error?.retryAfter || 0) || attempt * 2);
      await sleep(Math.min(retrySeconds * 1000, 15_000));
    }
  }
  throw lastError;
}

export async function listVerifiedReverseCardmarketMappings(store) {
  requireStore(store);
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,m.source_url,
      i.variant_code,i.language_code,i.verification_status
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
    WHERE m.source_name='cardmarket'
      AND m.source_variant_key='reverse'
      AND i.variant_code='reverse-holo'
      AND i.language_code='en'
      AND i.verification_status='verified'
      AND m.source_url IS NOT NULL
    ORDER BY m.source_record_id,m.card_identity_id`);
  return rows.map((row) => Object.freeze({
    id: row.id,
    cardIdentityId: row.card_identity_id,
    sourceRecordId: String(row.source_record_id),
    sourceVariantKey: row.source_variant_key,
    sourceUrl: row.source_url,
  }));
}

function makeReverseObservation(mapping, parsed, summary, observedAt, sourceSnapshotId) {
  return normaliseMarketObservationCandidate({
    ingestRunId: makeMarketIngestRunId(CARDMARKET_SOURCE_NAME, sourceSnapshotId),
    cardIdentityId: mapping.cardIdentityId,
    cardSourceMappingId: mapping.id,
    sourceName: CARDMARKET_SOURCE_NAME,
    sourceSnapshotId,
    sourceRecordId: mapping.sourceRecordId,
    sourceVariantKey: REVERSE_VARIANT_KEY,
    marketSegmentKey: REVERSE_SEGMENT_KEY,
    conditionCode: 'mixed',
    currencyCode: summary.currencyCode,
    observedAt,
    sourceEffectiveAt: observedAt,
    marketPrice: summary.marketPrice,
    lowPrice: summary.lowPrice,
    metricsJson: {
      pricingBasis: 'live_offer_sample',
      offerDerived: true,
      salesDerived: false,
      trendMetric: false,
      avgMetric: false,
      reverseHolo: true,
      language: 'English',
      qualifyingOffers: summary.qualifyingOffers,
      trimmedOffers: summary.trimmedOffers,
      trimCountPerTail: summary.trimCountPerTail,
      medianPrice: summary.medianPrice,
      q25: summary.q25,
      q75: summary.q75,
      confidence: summary.confidence,
      discardedOtherCurrencyOffers: summary.discardedOtherCurrencyOffers,
      certifiedProductUrl: parsed.productUrl,
      filteredProductUrl: parsed.filteredUrl,
    },
    rawPayload: {
      sourceRecordId: mapping.sourceRecordId,
      certifiedProductUrl: parsed.productUrl,
      filteredProductUrl: parsed.filteredUrl,
      observedAt,
      isReverseHolo: true,
      language: 'English',
      offers: summary.offers.map((offer) => ({
        articleId: offer.articleId,
        currencyCode: offer.currencyCode,
        price: offer.price,
        language: offer.language,
        condition: offer.condition,
        isReverseHolo: true,
      })),
    },
  });
}

function makeUnpricedRejection(mapping, parsed, summary, observedAt, sourceSnapshotId) {
  const code = summary.status === 'no_qualifying_offers'
    ? 'no_qualifying_reverse_offers'
    : 'insufficient_reverse_offers';
  return normaliseMarketIngestRejection({
    ingestRunId: makeMarketIngestRunId(CARDMARKET_SOURCE_NAME, sourceSnapshotId),
    sourceName: CARDMARKET_SOURCE_NAME,
    sourceSnapshotId,
    sourceRecordId: mapping.sourceRecordId,
    sourceVariantKey: REVERSE_VARIANT_KEY,
    rejectionCode: code,
    rejectionDetail: summary.status === 'no_qualifying_offers'
      ? 'Exact public Cardmarket product page loaded successfully but exposed no qualifying English reverse-holo offers'
      : `Exact public Cardmarket product page loaded successfully but only ${summary.qualifyingOffers} qualifying English reverse-holo offers were available`,
    rawPayload: {
      cardIdentityId: mapping.cardIdentityId,
      cardSourceMappingId: mapping.id,
      certifiedProductUrl: parsed.productUrl,
      filteredProductUrl: parsed.filteredUrl,
      isReverseHolo: true,
      language: 'English',
      qualifyingOffers: summary.qualifyingOffers || 0,
      currencyCode: summary.currencyCode || null,
      rowCount: parsed.rowCount,
    },
    createdAt: observedAt,
  });
}

export async function runCardmarketReversePublicMarketCycle({
  store,
  mode = 'dry-run',
  fetchImpl = globalThis.fetch,
  observedAt = Date.now(),
  minOffers = DEFAULT_MIN_OFFERS,
  concurrency = DEFAULT_CONCURRENCY,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
  mappings: providedMappings = null,
} = {}) {
  requireStore(store);
  const providerPolicy = assertFatePriceProviderApproved('cardmarket-public-product-page');
  const mappings = providedMappings || await listVerifiedReverseCardmarketMappings(store);
  const sourceSnapshotId = `pokemon-reverse-public-${new Date(observedAt).toISOString()}`;
  const observations = [];
  const rejections = [];
  const failures = [];
  const outcomes = new Array(mappings.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= mappings.length) return;
      const mapping = mappings[index];
      try {
        const page = await fetchWithRetry(mapping.sourceUrl, { fetchImpl });
        const parsed = parseCardmarketReverseOffersHtml(page.html, {
          sourceRecordId: mapping.sourceRecordId,
          productUrl: mapping.sourceUrl,
          filteredUrl: page.filteredUrl,
        });
        const summary = summariseReverseOfferMarket(parsed.offers, { minOffers });
        if (summary.status === 'priced') {
          const observation = makeReverseObservation(mapping, parsed, summary, observedAt, sourceSnapshotId);
          observations.push(observation);
          outcomes[index] = Object.freeze({
            cardIdentityId: mapping.cardIdentityId,
            sourceRecordId: mapping.sourceRecordId,
            status: 'priced',
            marketPrice: summary.marketPrice,
            currencyCode: summary.currencyCode,
            qualifyingOffers: summary.qualifyingOffers,
            confidence: summary.confidence,
          });
        } else {
          rejections.push(makeUnpricedRejection(mapping, parsed, summary, observedAt, sourceSnapshotId));
          outcomes[index] = Object.freeze({
            cardIdentityId: mapping.cardIdentityId,
            sourceRecordId: mapping.sourceRecordId,
            status: 'explicitly_unpriced',
            reason: summary.status,
            qualifyingOffers: summary.qualifyingOffers || 0,
            currencyCode: summary.currencyCode || null,
          });
        }
      } catch (error) {
        failures.push(Object.freeze({
          cardIdentityId: mapping.cardIdentityId,
          sourceRecordId: mapping.sourceRecordId,
          sourceUrl: mapping.sourceUrl,
          error: error instanceof Error ? error.message : String(error),
        }));
        outcomes[index] = Object.freeze({
          cardIdentityId: mapping.cardIdentityId,
          sourceRecordId: mapping.sourceRecordId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (requestDelayMs > 0) await sleep(requestDelayMs);
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, 4));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const reconciliation = Object.freeze({
    expectedReverseMappings: mappings.length,
    priced: observations.length,
    explicitlyUnpriced: rejections.length,
    unexplained: failures.length,
    explained: observations.length + rejections.length,
  });

  if (failures.length) {
    return Object.freeze({
      status: 'blocked',
      productionWrites: false,
      sourceSnapshotId,
      providerPolicy,
      reconciliation,
      outcomes: Object.freeze(outcomes),
      failures: Object.freeze(failures),
    });
  }

  const run = normaliseMarketIngestRun({
    sourceName: CARDMARKET_SOURCE_NAME,
    sourceSnapshotId,
    sourceVersion: sha256(`${sourceSnapshotId}|${mappings.length}|${observations.length}|${rejections.length}`).slice(0, 16),
    startedAt: observedAt,
    completedAt: Date.now(),
    status: rejections.length ? 'partial' : 'completed',
    recordsSeen: observations.length + rejections.length,
    recordsAccepted: observations.length,
    recordsRejected: rejections.length,
    metadataJson: {
      providerPolicyKey: providerPolicy.key,
      acquisitionMode: providerPolicy.acquisitionMode,
      pricingBasis: 'live_offer_sample',
      language: 'English',
      sourceVariantKey: REVERSE_VARIANT_KEY,
      publicFilter: 'language=1&isReverseHolo=Y',
      minimumOffers: minOffers,
      concurrency: workerCount,
      requestDelayMs,
      mappings: mappings.length,
      priced: observations.length,
      explicitlyUnpriced: rejections.length,
    },
    createdAt: observedAt,
  });

  let persistence = null;
  if (mode === 'persist') {
    persistence = await persistMarketEvidenceBatch(store, { run, observations, rejections });
  }

  return Object.freeze({
    status: 'complete',
    productionWrites: mode === 'persist',
    sourceSnapshotId,
    providerPolicy,
    run,
    persistence,
    reconciliation,
    outcomes: Object.freeze(outcomes),
    failures: Object.freeze([]),
  });
}
