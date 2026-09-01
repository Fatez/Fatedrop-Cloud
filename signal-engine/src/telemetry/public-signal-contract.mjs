import { getOperatorLocalRadarHealth } from '../encounters/operator-local-radar-intake.mjs';
import { deriveAlertFacets } from '../core/alert-facets.mjs';
import { effectiveSignalDeliveryPolicy, signalKindFrom, signalPubliclyVisible } from '../core/signal-visibility-policy.mjs';
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

function publicSignalFromAlert(alert) {
  return {
    id: String(alert.id),
    tcgCode: alert.tcgCode || 'unknown',
    state: String(alert.fateStage || '').toLowerCase(),
    kind: alert.signalKind || null,
    deliveryPolicy: alert.deliveryPolicy,
    interruptEligible: alert.interruptEligible === true,
    stockEpisode: alert.stockEpisode || null,
    availabilityTruth: alert.availabilityTruth,
    facets: alert.facets,
    productId: alert.productId || null,
    offerId: alert.offerId || null,
    retailerId: alert.retailerId || null,
    retailerName: alert.retailer || null,
    title: alert.title || 'Product activity',
    productType: alert.product?.productType || null,
    productUrl: alert.productUrl || null,
    imageUrl: alert.product?.imageUrl || null,
    priceGbp: pounds(alert.product?.pricePence),
    deliveredPriceGbp: pounds(alert.product?.deliveredPricePence),
    rrpGbp: pounds(alert.priceIntelligence?.rrpPence),
    markupPercent: alert.priceIntelligence?.rrpDeltaPercent ?? undefined,
    stockStatus: alert.product?.stockStatus || 'unknown',
    confidence: alert.confidence == null ? undefined : Number(alert.confidence),
    detectedAt: alert.detectedAt,
    reason: alert.message || null,
    target: {
      type: 'product',
      productId: alert.productId || null,
      offerId: alert.offerId || null,
      retailerId: alert.retailerId || null,
      productUrl: alert.productUrl || null,
      query: alert.title || '',
    },
  };
}

function publicSignalFromObject(signal) {
  const facets = signal.facets || deriveAlertFacets({ title: signal.title, retailerCountryCode: 'GB', evidence: signal.evidence });
  const deliveryPolicy = effectiveSignalDeliveryPolicy(signal);
  return {
    id: String(signal.id),
    tcgCode: signal.tcgCode || signal.tcg || 'unknown',
    state: String(signal.state),
    kind: signalKindFrom(signal) || null,
    deliveryPolicy,
    interruptEligible: deliveryPolicy === 'interrupt',
    facets,
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
  if (!signalPubliclyVisible(signal)) return false;
  if (signal?.state !== 'vanished') return true;
  if (!signal?.offerId) return false;
  const at = Number(signal.detectedAt);
  const priorManifested = allSignals
    .filter((item) => item.offerId === signal.offerId && item.state === 'manifested' && Number(item.detectedAt) < at)
    .sort((a, b) => Number(b.detectedAt) - Number(a.detectedAt))[0];
  if (!priorManifested) {
    return (Array.isArray(signal.evidence) ? signal.evidence : []).some((entry) => entry?.kind === 'prior_live_confirmation'
      && entry?.value === 'persisted_purchasable_offer'
      && Number(entry?.observedAt) > 0
      && Number(entry?.observedAt) < at);
  }
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
    const alerts = await listCanonicalPublicAlerts(store, { states: requestedStates, limit: safeLimit });
    return (Array.isArray(alerts) ? alerts : [])
      .filter((alert) => {
        const observedAt = Date.parse(String(alert.detectedAt || '')) / 1000;
        return Number.isFinite(observedAt) && observedAt >= safeSince;
      })
      .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt) || left.id.localeCompare(right.id))
      .slice(0, safeLimit)
      .map(publicSignalFromAlert);
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
    const requestedState = String(url.searchParams.get('state') || '').trim().toLowerCase();
    const state = PUBLIC_SIGNAL_STATES.includes(requestedState) ? requestedState : null;
    const since = Math.max(0, Number.parseInt(url.searchParams.get('since') || '0', 10) || 0);
    const before = Math.max(0, Number.parseInt(url.searchParams.get('before') || '0', 10) || 0);
    const beforeId = url.searchParams.get('beforeId')?.trim() || null;
    const currentOnly = ['1', 'true', 'yes'].includes(String(url.searchParams.get('current') || '').trim().toLowerCase());
    const alerts = await listCanonicalPublicAlerts(store, { id, state, since: since || null, before: before || null, beforeId, currentOnly, limit });
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

function safeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function safeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeNullableNumber(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeDiagnostics(diagnostics = {}) {
  const reliability = diagnostics.reliability || {};
  const monitors = diagnostics.monitors || {};
  const discordLatency = diagnostics.discordLatency || {};
  const discovery = diagnostics.discovery || {};

  return {
    absentLifecycleStages: Array.isArray(diagnostics.absentLifecycleStages)
      ? diagnostics.absentLifecycleStages.filter((value) => typeof value === 'string')
      : [],
    discordDeliveryIssues: safeCount(diagnostics.discordDeliveryIssues),
    duplicateSignalsSuppressed: safeCount(diagnostics.duplicateSignalsSuppressed),
    reliability: {
      orphanedDiscordSignals: safeCount(reliability.orphanedDiscordSignals),
      telemetryStoppedWhileSignalsContinue: reliability.telemetryStoppedWhileSignalsContinue === true,
      recentSignals: safeCount(reliability.recentSignals),
      recentDiscordAttempts: safeCount(reliability.recentDiscordAttempts),
      latestSignalAt: safeTimestamp(reliability.latestSignalAt),
      latestDiscordAttemptAt: safeTimestamp(reliability.latestDiscordAttemptAt),
    },
    monitors: {
      totalRetailers: safeCount(monitors.totalRetailers),
      activeRetailers: safeCount(monitors.activeRetailers),
      freshRetailers: safeCount(monitors.freshRetailers),
      staleRetailers: safeCount(monitors.staleRetailers),
      unhealthyRetailers: safeCount(monitors.unhealthyRetailers),
      regressedRetailers: safeCount(monitors.regressedRetailers),
      blockedRetailers: safeCount(monitors.blockedRetailers),
      onboardingRetailers: safeCount(monitors.onboardingRetailers),
      excludedRetailers: safeCount(monitors.excludedRetailers),
      degradedRetailers: safeCount(monitors.degradedRetailers),
      failureClassCounts: Object.fromEntries(
        Object.entries(monitors.failureClassCounts || {}).map(([key, value]) => [key, safeCount(value)]),
      ),
    },
    discordLatency: {
      sampleSize: safeCount(discordLatency.sampleSize),
      medianSeconds: safeNullableNumber(discordLatency.medianSeconds),
      p95Seconds: safeNullableNumber(discordLatency.p95Seconds),
    },
    discovery: {
      available: discovery.available === true,
      pending: safeCount(discovery.pending),
      retry: safeCount(discovery.retry),
      processed: safeCount(discovery.processed),
      failed: safeCount(discovery.failed),
      latestObservedAt: safeTimestamp(discovery.latestObservedAt),
      latestProcessedAt: safeTimestamp(discovery.latestProcessedAt),
      oldestActiveAt: safeTimestamp(discovery.oldestActiveAt),
    },
  };
}

function safeOperatorHealth(now = Math.floor(Date.now() / 1000)) {
  const health = getOperatorLocalRadarHealth();
  const completedAt = safeTimestamp(health.lastPollCompletedAt);
  const ageSeconds = completedAt == null ? null : Math.max(0, now - completedAt);
  const fresh = ageSeconds != null && ageSeconds <= Math.max(360, safeCount(health.intervalSeconds) * 3);
  return {
    available: health.started === true
      && health.lastStatus === 'ok'
      && health.canonicalStoreConfigured === true
      && health.webBridgeConfigured === true
      && health.githubAuthenticated === true
      && fresh,
    started: health.started === true,
    status: typeof health.lastStatus === 'string' ? health.lastStatus : 'unknown',
    ageSeconds,
    intervalSeconds: safeCount(health.intervalSeconds),
    canonicalStoreConfigured: health.canonicalStoreConfigured === true,
    webBridgeConfigured: health.webBridgeConfigured === true,
    githubAuthenticated: health.githubAuthenticated === true,
    issuesSeen: safeCount(health.issuesSeen),
    published: safeCount(health.published),
    held: safeCount(health.held),
    retry: safeCount(health.retry),
    invalid: safeCount(health.invalid),
    lastErrorCode: typeof health.lastErrorCode === 'string' ? health.lastErrorCode : null,
  };
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
    diagnostics: safeDiagnostics(summary.diagnostics),
    localRadarOperator: safeOperatorHealth(),
  });
}
