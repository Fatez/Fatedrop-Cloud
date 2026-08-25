import { resolveFateTraderFlags } from '../feature-flags.mjs';
import {
  getVerifiedCardFromStore,
  listVerifiedCardsFromStore,
  listVerifiedCardSeriesFromStore,
  listVerifiedCardSetsFromStore,
} from './store.mjs';

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

function notFound(res, code = 'NOT_FOUND', message = 'Catalogue resource not found.') {
  json(res, 404, {
    ok: false,
    error: { code, message, retryable: false, details: {} },
    meta: meta(),
  });
}

function safeLimit(url, fallback, max) {
  return Math.min(max, Math.max(1, Number.parseInt(url.searchParams.get('limit') || String(fallback), 10) || fallback));
}

export function isFateTraderCataloguePath(pathname) {
  return pathname === '/v1/cards'
    || pathname.startsWith('/v1/cards/')
    || pathname === '/v1/card-series'
    || pathname === '/v1/card-sets'
    || /^\/v1\/card-sets\/[^/]+\/cards$/.test(pathname);
}

export async function handleFateTraderCatalogue(req, res, {
  store,
  flags = resolveFateTraderFlags(),
} = {}) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  if (req.method !== 'GET' || !isFateTraderCataloguePath(url.pathname)) return false;

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
