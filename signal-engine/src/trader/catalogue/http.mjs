import { resolveFateTraderFlags } from '../feature-flags.mjs';
import {
  getVerifiedCardFromStore,
  listVerifiedCardsFromStore,
  listVerifiedCardSeriesFromStore,
  listVerifiedCardSetsFromStore,
} from './store.mjs';
import { listScopedVerifiedCardsFromStore } from './fate-price-scope-store.mjs';
import { getFatePriceFromStore, getFatePriceHistoryFromStore, getFatePricesFromStore } from '../value/fate-price-service.mjs';
import { FatePriceStoreUnavailableError } from '../value/fate-price-store.mjs';

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function meta() {
  return { requestId: null, apiVersion: 'v1' };
}

function ok(res, data) {
  json(res, 200, { ok: true, data, meta: meta() });
}

function errorResponse(res, status, code, message, retryable = false, details = {}) {
  json(res, status, {
    ok: false,
    error: { code, message, retryable, details },
    meta: meta(),
  });
}

function notFound(res, code = 'NOT_FOUND', message = 'Catalogue resource not found.') {
  errorResponse(res, 404, code, message, false);
}

function safeLimit(url, fallback, max) {
  return Math.min(max, Math.max(1, Number.parseInt(url.searchParams.get('limit') || String(fallback), 10) || fallback));
}

function isFatePricePath(pathname) {
  return pathname === '/v1/fate-price'
    || pathname === '/v1/fate-price/cards'
    || pathname === '/v1/fate-price/series'
    || pathname === '/v1/fate-price/sets'
    || /^\/v1\/fate-price\/cards\/[^/]+$/.test(pathname)
    || /^\/v1\/fate-price\/[^/]+$/.test(pathname)
    || /^\/v1\/fate-price\/[^/]+\/history$/.test(pathname);
}

function fatePriceScope(url) {
  return {
    currencyCode: url.searchParams.get('currency') || null,
    marketSegmentKey: url.searchParams.get('marketSegment') || null,
    conditionCode: url.searchParams.get('condition') || null,
  };
}

function fatePriceIds(url) {
  const ids = [
    ...url.searchParams.getAll('id'),
    ...(url.searchParams.get('ids') || '').split(','),
  ].map((value) => value.trim()).filter(Boolean);
  return [...new Set(ids)];
}

export function isFateTraderCataloguePath(pathname) {
  return pathname === '/v1/cards'
    || pathname.startsWith('/v1/cards/')
    || pathname === '/v1/card-series'
    || pathname === '/v1/card-sets'
    || /^\/v1\/card-sets\/[^/]+\/cards$/.test(pathname)
    || isFatePricePath(pathname);
}

export async function handleFateTraderCatalogue(req, res, {
  store,
  flags = resolveFateTraderFlags(),
} = {}) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  if (req.method !== 'GET' || !isFateTraderCataloguePath(url.pathname)) return false;

  // Fate Price is a shared canonical valuation service for Collectors, Pulse and
  // Trader. It is intentionally not coupled to Fate Trader UI feature flags.
  if (isFatePricePath(url.pathname)) {
    try {
      const scope = fatePriceScope(url);

      if (url.pathname === '/v1/fate-price/series') {
        const rows = await listVerifiedCardSeriesFromStore(store, {
          tcgCode: (url.searchParams.get('tcg') || 'pokemon').trim(),
          limit: safeLimit(url, 100, 500),
        });
        ok(res, { series: rows, count: rows.length });
        return true;
      }

      if (url.pathname === '/v1/fate-price/sets') {
        const rows = await listVerifiedCardSetsFromStore(store, {
          tcgCode: (url.searchParams.get('tcg') || 'pokemon').trim(),
          seriesId: (url.searchParams.get('seriesId') || '').trim() || null,
          limit: safeLimit(url, 500, 1000),
        });
        ok(res, { sets: rows, count: rows.length });
        return true;
      }

      if (url.pathname === '/v1/fate-price/cards') {
        const query = (url.searchParams.get('q') || '').trim();
        const tcgCode = (url.searchParams.get('tcg') || '').trim() || null;
        const seriesId = (url.searchParams.get('seriesId') || '').trim() || null;
        const setId = (url.searchParams.get('setId') || '').trim() || null;
        if (query.length < 2 && !tcgCode && !seriesId && !setId) {
          errorResponse(res, 400, 'FATE_PRICE_CARD_FILTER_REQUIRED', 'Enter at least two search characters or choose a TCG, series, or exact set.');
          return true;
        }
        const cards = await listScopedVerifiedCardsFromStore(store, {
          tcgCode,
          seriesId,
          setId,
          query: query || null,
          languageCode: url.searchParams.get('language') || null,
          variantCode: url.searchParams.get('variant') || null,
          limit: safeLimit(url, 50, 100),
        });
        ok(res, { cards, count: cards.length });
        return true;
      }

      const priceCardMatch = url.pathname.match(/^\/v1\/fate-price\/cards\/([^/]+)$/);
      if (priceCardMatch) {
        const card = await getVerifiedCardFromStore(store, decodeURIComponent(priceCardMatch[1]));
        if (!card) notFound(res, 'CARD_IDENTITY_NOT_VERIFIED', 'The requested card identity is not available.');
        else ok(res, { card });
        return true;
      }

      if (url.pathname === '/v1/fate-price') {
        const ids = fatePriceIds(url);
        if (!ids.length) {
          errorResponse(res, 400, 'FATE_PRICE_CARD_IDS_REQUIRED', 'At least one exact FateDrop card identity is required.');
          return true;
        }
        if (ids.length > 100) {
          errorResponse(res, 400, 'FATE_PRICE_BATCH_TOO_LARGE', 'Fate Price supports at most 100 card identities per request.');
          return true;
        }
        const prices = await getFatePricesFromStore(store, { cardIdentityIds: ids, ...scope });
        ok(res, { prices, count: prices.length });
        return true;
      }

      const historyMatch = url.pathname.match(/^\/v1\/fate-price\/([^/]+)\/history$/);
      if (historyMatch) {
        const cardIdentityId = decodeURIComponent(historyMatch[1]);
        const card = await getVerifiedCardFromStore(store, cardIdentityId);
        if (!card) {
          notFound(res, 'CARD_IDENTITY_NOT_VERIFIED', 'The requested card identity is not available.');
          return true;
        }
        const days = Number.parseInt(url.searchParams.get('days') || '30', 10);
        const history = await getFatePriceHistoryFromStore(store, { cardIdentityId, days, ...scope });
        ok(res, { history });
        return true;
      }

      const match = url.pathname.match(/^\/v1\/fate-price\/([^/]+)$/);
      const cardIdentityId = decodeURIComponent(match?.[1] || '');
      const card = await getVerifiedCardFromStore(store, cardIdentityId);
      if (!card) {
        notFound(res, 'CARD_IDENTITY_NOT_VERIFIED', 'The requested card identity is not available.');
        return true;
      }
      const fatePrice = await getFatePriceFromStore(store, { cardIdentityId, ...scope });
      ok(res, { fatePrice });
      return true;
    } catch (error) {
      if (error instanceof FatePriceStoreUnavailableError) {
        errorResponse(res, 503, 'FATE_PRICE_UNAVAILABLE', error.message, true);
        return true;
      }
      if (error instanceof TypeError) {
        errorResponse(res, 400, 'INVALID_FATE_PRICE_REQUEST', error.message, false);
        return true;
      }
      throw error;
    }
  }

  // Disabled catalogue routes behave as unavailable rather than leaking a dark
  // feature surface or relying on client-side navigation flags.
  if (!flags.enabled || !flags.catalogueEnabled) {
    notFound(res);
    return true;
  }

  if (url.pathname === '/v1/card-series') {
    const rows = await listVerifiedCardSeriesFromStore(store, {
      tcgCode: url.searchParams.get('tcg') || 'pokemon',
      limit: safeLimit(url, 100, 500),
    });
    ok(res, { series: rows, count: rows.length });
    return true;
  }

  if (url.pathname === '/v1/card-sets') {
    const rows = await listVerifiedCardSetsFromStore(store, {
      tcgCode: url.searchParams.get('tcg') || 'pokemon',
      seriesId: url.searchParams.get('seriesId') || null,
      limit: safeLimit(url, 500, 1000),
    });
    ok(res, { sets: rows, count: rows.length });
    return true;
  }

  const setCardsMatch = url.pathname.match(/^\/v1\/card-sets\/([^/]+)\/cards$/);
  if (setCardsMatch) {
    const rows = await listVerifiedCardsFromStore(store, {
      setId: decodeURIComponent(setCardsMatch[1]),
      query: url.searchParams.get('q') || null,
      languageCode: url.searchParams.get('language') || null,
      variantCode: url.searchParams.get('variant') || null,
      limit: safeLimit(url, 250, 500),
    });
    ok(res, { cards: rows, count: rows.length });
    return true;
  }

  if (url.pathname === '/v1/cards') {
    const rows = await listVerifiedCardsFromStore(store, {
      setId: url.searchParams.get('setId') || null,
      query: url.searchParams.get('q') || null,
      languageCode: url.searchParams.get('language') || null,
      variantCode: url.searchParams.get('variant') || null,
      limit: safeLimit(url, 200, 500),
    });
    ok(res, { cards: rows, count: rows.length });
    return true;
  }

  const cardMatch = url.pathname.match(/^\/v1\/cards\/([^/]+)$/);
  if (cardMatch) {
    const card = await getVerifiedCardFromStore(store, decodeURIComponent(cardMatch[1]));
    if (!card) notFound(res, 'CARD_IDENTITY_NOT_VERIFIED', 'The requested card identity is not available.');
    else ok(res, { card });
    return true;
  }

  return false;
}
