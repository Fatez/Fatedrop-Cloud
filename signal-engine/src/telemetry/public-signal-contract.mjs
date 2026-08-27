import { listCanonicalPublicAlerts } from './public-alert-contract.mjs';
import { loadSignalHealthSummary } from './signal-health-summary.mjs';

const PUBLIC_SIGNAL_STATES = ['whisper', 'echo', 'manifested', 'vanished'];
export const PUBLIC_SIGNAL_CONTRACT_VERSION = 1;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function safeStates(value) {
  const requested = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => PUBLIC_SIGNAL_STATES.includes(item));
  return requested.length ? [...new Set(requested)] : PUBLIC_SIGNAL_STATES;
}

function pounds(pence) {
  const value = Number(pence);
  return Number.isFinite(value) ? value / 100 : undefined;
}

function iso(epochSeconds) {
  const value = Number(epochSeconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;
}

function publicSignalFromRow(row) {
  return {
    id: String(row.id),
    state: String(row.state),
    productId: row.product_id || null,
    offerId: row.offer_id || null,
    retailerId: row.retailer_id || null,
    retailerName: row.retailer_name || null,
    title: row.title || 'Product activity',
    productType: row.product_type || null,
    productUrl: row.url || null,
    imageUrl: row.image_url || null,
    priceGbp: pounds(row.price_pence),
    deliveredPriceGbp: pounds(row.delivered_price_pence),
    rrpGbp: pounds(row.rrp_pence),
    markupPercent: row.markup_percent == null ? undefined : Number(row.markup_percent),
    stockStatus: row.stock_status || 'unknown',
    confidence: row.confidence == null ? undefined : Number(row.confidence),
    detectedAt: iso(row.detected_at),
    reason: row.reason || null,
    target: {
      type: 'product',
      productId: row.product_id || null,
      offerId: row.offer_id || null,
      retailerId: row.retailer_id || null,
      productUrl: row.url || null,
      query: row.title || '',
    },
  };
}

function publicSignalFromObject(signal) {
  return {
    id: String(signal.id),
    state: String(signal.state),
    productId: signal.productId || null,
    offerId: signal.offerId || null,
    retailerId: signal.retailerId || null,
    retailerName: signal.retailerName || null,
    title: signal.title || 'Product activity',
    productType: signal.productType || null,
    productUrl: signal.url || signal.target?.productUrl || null,
    imageUrl: signal.imageUrl || null,
    priceGbp: pounds(signal.pricePence),
    deliveredPriceGbp: pounds(signal.deliveredPricePence),
    rrpGbp: pounds(signal.rrpPence),
    markupPercent: Number.isFinite(signal.markupPercent) ? signal.markupPercent : undefined,
    stockStatus: signal.stockStatus || 'unknown',
    confidence: Number.isFinite(signal.confidence) ? signal.confidence : undefined,
    detectedAt: iso(signal.detectedAt),
    reason: signal.reason || null,
    target: signal.target || {
      type: 'product',
      productId: signal.productId || null,
      offerId: signal.offerId || null,
      retailerId: signal.retailerId || null,
      productUrl: signal.url || null,
      query: signal.title || '',
    },
  };
}

function canonicalSignalVisible(signal, allSignals) {
  if (signal?.state !== 'vanished') return true;
  if (!signal?.offerId) return false;
  const at = Number(signal.detectedAt);
  const priorManifested = allSignals
    .filter((item) => item.offerId === signal.offerId && item.state === 'manifested' && Number(item.detectedAt) < at)
    .sort((a, b) => Number(b.detectedAt) - Number(a.detectedAt))[0];
  if (!priorManifested) return false;
  return !allSignals.some((item) => item.offerId === signal.offerId
    && item.state === 'vanished'
    && Number(item.detectedAt) > Number(priorManifested.detectedAt)
    && Number(item.detectedAt) < at);
}

export async function listCanonicalPublicSignals(store, { states = PUBLIC_SIGNAL_STATES, since = 0, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const safeSince = Math.max(0, Math.trunc(Number(since) || 0));
  const requestedStates = Array.isArray(states) && states.length
    ? states.map((state) => String(state).toLowerCase()).filter((state) => PUBLIC_SIGNAL_STATES.includes(state))
    : PUBLIC_SIGNAL_STATES;

  if (store && typeof store.pool === 'function') {
    const pool = await store.pool();
    const { rows } = await pool.query(`
      SELECT s.*
      FROM fatedrop_signals s
      WHERE s.detected_at >= $1
        AND s.state = ANY($2)
        AND (
          s.state <> 'vanished'
          OR (
            s.offer_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM fatedrop_signals m
              WHERE m.offer_id=s.offer_id
                AND m.state='manifested'
                AND m.detected_at < s.detected_at
                AND NOT EXISTS (
                  SELECT 1
                  FROM fatedrop_signals v
                  WHERE v.offer_id=s.offer_id
                    AND v.state='vanished'
                    AND v.detected_at > m.detected_at
                    AND v.detected_at < s.detected_at
                )
            )
          )
        )
      ORDER BY s.detected_at DESC
      LIMIT $3`, [safeSince, requestedStates, safeLimit]);
    return rows.map(publicSignalFromRow);
  }

  if (!store || typeof store.listSignals !== 'function') return [];
  const history = await store.listSignals({ states: PUBLIC_SIGNAL_STATES, retailerIds: [], since: 0, limit: 20_000 });
  return history
    .filter((signal) => Number(signal.detectedAt) >= safeSince)
    .filter((signal) => requestedStates.includes(String(signal.state).toLowerCase()))
    .filter((signal) => canonicalSignalVisible(signal, history))
    .sort((a, b) => Number(b.detectedAt) - Number(a.detectedAt))
    .slice(0, safeLimit)
    .map(publicSignalFromObject);
}

export async function handlePublicSignals(req, res, { store } = {}) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const detail = String(url.searchParams.get('detail') || '').trim().toLowerCase();
  if (detail === 'alerts') {
    const id = url.searchParams.get('id')?.trim() || null;
    const alerts = await listCanonicalPublicAlerts(store, { id, limit });
    return json(res, 200, {
      success: Array.isArray(alerts),
      available: Array.isArray(alerts),
      contractVersion: PUBLIC_SIGNAL_CONTRACT_VERSION,
      source: 'FATEDROP_CLOUD',
      count: Array.isArray(alerts) ? alerts.length : 0,
      generatedAt: new Date().toISOString(),
      alerts: Array.isArray(alerts) ? alerts : [],
    });
  }

  const since = Math.max(0, Number.parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const states = safeStates(url.searchParams.get('state'));
  const signals = await listCanonicalPublicSignals(store, { states, since, limit });
  return json(res, 200, {
    success: true,
    contractVersion: PUBLIC_SIGNAL_CONTRACT_VERSION,
    source: 'FATEDROP_CLOUD',
    count: signals.length,
    generatedAt: new Date().toISOString(),
    signals,
  });
}

function safeDelivery(delivery = {}) {
  return Object.fromEntries(PUBLIC_SIGNAL_STATES.map((state) => {
    const row = delivery[state] || {};
    return [state, {
      sent: Number(row.sent) || 0,
      policySkipped: Number(row.policySkipped) || 0,
      duplicateSuppressed: Number(row.duplicateSuppressed) || 0,
      issues: Number(row.issues) || 0,
      todaySent: Number(row.todaySent) || 0,
      trend: Array.isArray(row.trend) ? row.trend.map((point) => ({
        measuredAt: Number(point.measuredAt),
        sent: Number(point.sent) || 0,
        policySkipped: Number(point.policySkipped) || 0,
        duplicateSuppressed: Number(point.duplicateSuppressed) || 0,
        issues: Number(point.issues) || 0,
      })) : [],
    }];
  }));
}

export async function handlePublicSignalSummary(req, res, { store } = {}) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const days = Math.max(2, Math.min(30, Number.parseInt(url.searchParams.get('days') || '7', 10) || 7));
  const summary = await loadSignalHealthSummary(store, { days });
  if (summary?.available !== true) {
    return json(res, 200, {
      success: false,
      available: false,
      contractVersion: PUBLIC_SIGNAL_CONTRACT_VERSION,
      source: 'FATEDROP_CLOUD',
      generatedAt: new Date().toISOString(),
    });
  }
  return json(res, 200, {
    success: true,
    available: true,
    contractVersion: PUBLIC_SIGNAL_CONTRACT_VERSION,
    source: 'FATEDROP_CLOUD',
    generatedAt: new Date(Number(summary.generatedAt) * 1000).toISOString(),
    days: summary.days,
    day0: summary.day0,
    lifecycle: summary.lifecycle,
    delivery: safeDelivery(summary.delivery),
  });
}
