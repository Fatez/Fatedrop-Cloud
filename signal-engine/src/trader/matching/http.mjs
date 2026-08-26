import { resolveFateTraderSessionUser } from '../auth.mjs';
import { resolveFateTraderFlags } from '../feature-flags.mjs';
import { findTradeOpportunities } from './service.mjs';

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}
function meta() { return { requestId: null, apiVersion: 'v1' }; }
function ok(res, data) { json(res, 200, { ok: true, data, meta: meta() }); }
function fail(res, status, code, message, { retryable = false, details = {} } = {}) {
  json(res, status, { ok: false, error: { code, message, retryable, details }, meta: meta() });
}
function limitFor(url) {
  const parsed = Number(url.searchParams.get('limit') || 50);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.trunc(parsed))) : 50;
}

export function isFateTraderMatchingPath(pathname) {
  return pathname === '/v1/trader/finder';
}

export async function handleFateTraderMatching(req, res, {
  store,
  flags = resolveFateTraderFlags(),
  resolveUser = resolveFateTraderSessionUser,
} = {}) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  if (!isFateTraderMatchingPath(url.pathname)) return false;

  if (!flags.enabled || !flags.catalogueEnabled || !flags.collectionEnabled || !flags.binderEnabled || !flags.networkEnabled || !flags.matchingEnabled) {
    fail(res, 404, 'NOT_FOUND', 'Fate Trade Finder is not enabled.');
    return true;
  }

  if (req.method !== 'GET') {
    fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }

  const user = await resolveUser(store, req);
  if (!user?.id) {
    fail(res, 401, 'AUTH_REQUIRED', 'A valid FateDrop session is required.');
    return true;
  }

  try {
    const data = await findTradeOpportunities(store, { userId: user.id, limit: limitFor(url) });
    ok(res, data);
    return true;
  } catch (error) {
    if (error instanceof TypeError) {
      fail(res, 400, 'INVALID_TRADER_INPUT', error.message);
      return true;
    }
    throw error;
  }
}
