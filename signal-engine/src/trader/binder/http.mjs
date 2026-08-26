import { resolveFateTraderFlags } from '../feature-flags.mjs';
import { resolveFateTraderSessionUser } from '../auth.mjs';
import { makeFateTcgId } from '../card-identity.mjs';
import { listExactWantsFromStore } from '../collection/store.mjs';
import { handleFateTraderMatching } from '../matching/http.mjs';
import {
  addTradeBinderItem,
  getTradeBinder,
  getWantConstraints,
  patchTradeBinderItem,
  patchTradeBinderSettings,
  putWantConstraints,
} from './service.mjs';

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}
function meta() { return { requestId: null, apiVersion: 'v1' }; }
function ok(res, data, status = 200) { json(res, status, { ok: true, data, meta: meta() }); }
function fail(res, status, code, message, { retryable = false, details = {} } = {}) {
  json(res, status, { ok: false, error: { code, message, retryable, details }, meta: meta() });
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('REQUEST_TOO_LARGE');
  }
  return raw ? JSON.parse(raw) : {};
}
function binderItemId(pathname) {
  return pathname.match(/^\/v1\/trader\/binder\/items\/([^/]+)$/)?.[1] || null;
}
function structuredWantId(pathname) {
  return pathname.match(/^\/v1\/trader\/wants\/([^/]+)$/)?.[1] || null;
}
function tcgIdForRequest(url) {
  const tcg = String(url.searchParams.get('tcg') || 'pokemon').trim().toLowerCase();
  if (tcg !== 'pokemon') {
    const error = new Error('Only Pokémon is supported in Fate Trader v1');
    error.code = 'TCG_NOT_SUPPORTED';
    throw error;
  }
  return makeFateTcgId(tcg);
}

export function isFateTraderBinderPath(pathname) {
  return pathname === '/v1/trader/binder'
    || pathname === '/v1/trader/binder/items'
    || /^\/v1\/trader\/binder\/items\/[^/]+$/.test(pathname)
    || pathname === '/v1/trader/wants'
    || /^\/v1\/trader\/wants\/[^/]+$/.test(pathname)
    || pathname === '/v1/trader/finder';
}

export async function handleFateTraderBinder(req, res, {
  store,
  flags = resolveFateTraderFlags(),
  resolveUser = resolveFateTraderSessionUser,
} = {}) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  if (!isFateTraderBinderPath(url.pathname)) return false;

  if (url.pathname === '/v1/trader/finder') {
    return handleFateTraderMatching(req, res, { store, flags, resolveUser });
  }

  if (!flags.enabled || !flags.catalogueEnabled || !flags.collectionEnabled || !flags.binderEnabled) {
    fail(res, 404, 'NOT_FOUND', 'Fate Trader resource not found.');
    return true;
  }

  const user = await resolveUser(store, req);
  if (!user?.id) {
    fail(res, 401, 'AUTH_REQUIRED', 'A valid FateDrop session is required.');
    return true;
  }

  try {
    if (url.pathname === '/v1/trader/binder' && req.method === 'GET') {
      const data = await getTradeBinder(store, { userId: user.id, tcgId: tcgIdForRequest(url) });
      ok(res, data);
      return true;
    }
    if (url.pathname === '/v1/trader/binder' && req.method === 'PATCH') {
      const body = await readBody(req);
      const binder = await patchTradeBinderSettings(store, { userId: user.id, tcgId: tcgIdForRequest(url), input: body });
      ok(res, { binder });
      return true;
    }
    if (url.pathname === '/v1/trader/binder/items' && req.method === 'POST') {
      const body = await readBody(req);
      const item = await addTradeBinderItem(store, { userId: user.id, input: body });
      ok(res, { item }, 201);
      return true;
    }

    const itemId = binderItemId(url.pathname);
    if (itemId && req.method === 'PATCH') {
      const body = await readBody(req);
      const item = await patchTradeBinderItem(store, { userId: user.id, itemId: decodeURIComponent(itemId), input: body });
      if (!item) fail(res, 404, 'BINDER_ITEM_NOT_FOUND', 'Trade Binder item not found.');
      else ok(res, { item });
      return true;
    }
    if (itemId && req.method === 'DELETE') {
      const expectedRevision = url.searchParams.get('expectedRevision');
      const item = await patchTradeBinderItem(store, {
        userId: user.id,
        itemId: decodeURIComponent(itemId),
        input: { status: 'withdrawn', expectedRevision: expectedRevision == null ? undefined : Number(expectedRevision) },
      });
      if (!item) fail(res, 404, 'BINDER_ITEM_NOT_FOUND', 'Trade Binder item not found.');
      else ok(res, { item, withdrawn: true });
      return true;
    }

    if (url.pathname === '/v1/trader/wants' && req.method === 'GET') {
      const wants = await listExactWantsFromStore(store, { userId: user.id, limit: 1000 });
      const enriched = await Promise.all(wants.map(async (want) => ({
        ...want,
        constraints: await getWantConstraints(store, { userId: user.id, fateCardId: want.fateCardId }),
      })));
      ok(res, { wants: enriched, count: enriched.length });
      return true;
    }

    const fateCardId = structuredWantId(url.pathname);
    if (fateCardId && req.method === 'GET') {
      const constraints = await getWantConstraints(store, { userId: user.id, fateCardId: decodeURIComponent(fateCardId) });
      if (!constraints) fail(res, 404, 'WANT_NOT_FOUND', 'Active Want or structured constraints not found.');
      else ok(res, { constraints });
      return true;
    }
    if (fateCardId && req.method === 'PUT') {
      const body = await readBody(req);
      const constraints = await putWantConstraints(store, { userId: user.id, fateCardId: decodeURIComponent(fateCardId), input: body });
      ok(res, { constraints });
      return true;
    }

    fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  } catch (error) {
    if (error?.code === 'TCG_NOT_SUPPORTED') {
      fail(res, 400, 'TCG_NOT_SUPPORTED', error.message);
      return true;
    }
    if (error?.code === 'COLLECTION_ITEM_NOT_TRADEABLE') {
      fail(res, 409, 'COLLECTION_ITEM_NOT_TRADEABLE', 'The collection item is not currently owned and available to trade.');
      return true;
    }
    if (error?.code === 'BINDER_ITEM_EXISTS') {
      fail(res, 409, 'BINDER_ITEM_EXISTS', 'This collection item already has a Trade Binder entry.');
      return true;
    }
    if (error?.code === 'BINDER_NOT_PUBLIC') {
      fail(res, 409, 'BINDER_NOT_PUBLIC', 'Make the Trade Binder network-visible before publishing an item.');
      return true;
    }
    if (error?.code === 'INVALID_BINDER_TRANSITION') {
      fail(res, 409, 'INVALID_BINDER_TRANSITION', error.message);
      return true;
    }
    if (error?.code === 'REVISION_CONFLICT') {
      fail(res, 409, 'REVISION_CONFLICT', 'The Trader record changed since it was last read. Refresh and retry.');
      return true;
    }
    if (error?.code === 'WANT_NOT_FOUND') {
      fail(res, 404, 'WANT_NOT_FOUND', 'Create an active exact Want before adding structured constraints.');
      return true;
    }
    if (error?.message === 'REQUEST_TOO_LARGE') {
      fail(res, 413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
      return true;
    }
    if (error instanceof SyntaxError) {
      fail(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
      return true;
    }
    if (error instanceof TypeError) {
      fail(res, 400, 'INVALID_TRADER_INPUT', error.message);
      return true;
    }
    throw error;
  }
}