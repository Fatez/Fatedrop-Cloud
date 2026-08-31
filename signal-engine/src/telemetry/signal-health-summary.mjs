import {
  discordEligibleSignalSqlFilter,
  publicSignalSqlFilter,
  validVanishedSqlFilter,
} from "../core/signal-visibility-policy.mjs";

const LIFECYCLE_STATES = ["whisper", "echo", "manifested", "vanished"];
const ORPHAN_GRACE_SECONDS = 120;
const RELIABILITY_LOOKBACK_SECONDS = 24 * 60 * 60;

function startOfUtcDay(timestamp) {
  const date = new Date(timestamp * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}
function safeWindow(days, now) {
  const safeDays = Math.min(30, Math.max(2, Math.trunc(Number(days) || 7)));
  const day0 = startOfUtcDay(now) - ((safeDays - 1) * 86_400);
  return { safeDays, day0 };
}
function emptyLifecycle(day0, days) {
  return Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, { total: 0, today: 0, trend: Array.from({ length: days }, (_, index) => ({ measuredAt: day0 + (index * 86_400), value: 0 })) }]));
}
function emptyDelivery(day0, days) {
  return Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, { sent: 0, policySkipped: 0, duplicateSuppressed: 0, issues: 0, todaySent: 0, latencySampleSize: 0, medianLatencySeconds: null, p95LatencySeconds: null, trend: Array.from({ length: days }, (_, index) => ({ measuredAt: day0 + (index * 86_400), sent: 0, policySkipped: 0, duplicateSuppressed: 0, issues: 0 })) }]));
}
function monitorDiagnostics(monitorRows = []) {
  const rows = Array.isArray(monitorRows) ? monitorRows : [];
  const excluded = rows.filter((row) => row?.registryState && row.registryState !== "monitored");
  const active = rows.filter((row) => !row?.registryState || row.registryState === "monitored");
  const categories = { fresh: [], stale: [], blocked: [], onboarding: [], regressed: [] };
  for (const row of active) {
    const failure = `${row?.failureCode || ""} ${row?.lastError || ""}`;
    if (row?.healthy === true && row?.stale !== true) categories.fresh.push(row);
    else if (row?.stale === true) categories.stale.push(row);
    else if (/\b403\b|access[_ -]?blocked|retailer_access_blocked/i.test(failure)) categories.blocked.push(row);
    else if (!row?.lastSuccessAt) categories.onboarding.push(row);
    else categories.regressed.push(row);
  }
  const ids = (items) => items.map((row) => row.id);
  return {
    ledgerRetailers: rows.length,
    totalRetailers: active.length,
    activeRetailers: active.length,
    freshRetailers: categories.fresh.length,
    staleRetailers: categories.stale.length,
    unhealthyRetailers: categories.regressed.length,
    regressedRetailers: categories.regressed.length,
    blockedRetailers: categories.blocked.length,
    onboardingRetailers: categories.onboarding.length,
    excludedRetailers: excluded.length,
    degradedRetailers: categories.stale.length + categories.blocked.length + categories.regressed.length,
    freshRetailerIds: ids(categories.fresh),
    staleRetailerIds: ids(categories.stale),
    unhealthyRetailerIds: ids(categories.regressed),
    regressedRetailerIds: ids(categories.regressed),
    blockedRetailerIds: ids(categories.blocked),
    onboardingRetailerIds: ids(categories.onboarding),
    excludedRetailerIds: ids(excluded),
    previouslyHealthyBlockedRetailerIds: ids(categories.blocked.filter((row) => row?.lastSuccessAt)),
  };
}
function reliabilityDiagnostics({ orphanRows = [], freshnessRows = [], now }) {
  const orphans = Array.isArray(orphanRows) ? orphanRows : [];
  const orphanTotal = Number(orphans[0]?.orphan_total ?? orphans.length);
  const freshness = freshnessRows?.[0] || {};
  const latestSignalAt = freshness.latest_signal_at == null ? null : Number(freshness.latest_signal_at);
  const latestDiscordAttemptAt = freshness.latest_discord_attempt_at == null ? null : Number(freshness.latest_discord_attempt_at);
  const recentSignals = Number(freshness.recent_signals || 0);
  const recentDiscordAttempts = Number(freshness.recent_discord_attempts || 0);
  return {
    orphanGraceSeconds: ORPHAN_GRACE_SECONDS,
    orphanedDiscordSignals: Number.isFinite(orphanTotal) ? orphanTotal : orphans.length,
    orphanSampleTruncated: Number.isFinite(orphanTotal) && orphanTotal > orphans.length,
    orphanedSignalIds: orphans.map((row) => row.id),
    orphanedSignals: orphans.map((row) => ({ id: row.id, state: row.state, retailerId: row.retailer_id, retailerName: row.retailer_name, title: row.title, detectedAt: Number(row.detected_at) })),
    latestSignalAt,
    latestDiscordAttemptAt,
    recentSignals,
    recentDiscordAttempts,
    telemetryStoppedWhileSignalsContinue: recentSignals > 0 && recentDiscordAttempts === 0 && latestSignalAt != null && now - latestSignalAt >= ORPHAN_GRACE_SECONDS,
  };
}
function discoveryDiagnostics(discoveryRows = []) {
  const row = Array.isArray(discoveryRows) ? (discoveryRows[0] || {}) : {};
  const numeric = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const epoch = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    available: row.discovery_available === true,
    pending: numeric(row.pending),
    retry: numeric(row.retry),
    processed: numeric(row.processed),
    failed: numeric(row.failed),
    latestObservedAt: epoch(row.latest_observed_at),
    latestProcessedAt: epoch(row.latest_processed_at),
    oldestActiveAt: epoch(row.oldest_active_at),
  };
}

export function buildSignalHealthSummary({ detectionRows = [], deliveryRows = [], latencyRows = [], monitorRows = [], orphanRows = [], freshnessRows = [], discoveryRows = [], days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
  const { safeDays, day0 } = safeWindow(days, now);
  const lifecycle = emptyLifecycle(day0, safeDays);
  const delivery = emptyDelivery(day0, safeDays);
  for (const row of detectionRows) {
    const state = String(row?.state || "").toLowerCase(); const measuredAt = Number(row.measured_at); const value = Number(row.count);
    if (!LIFECYCLE_STATES.includes(state) || !Number.isFinite(measuredAt) || !Number.isFinite(value)) continue;
    const index = Math.floor((measuredAt - day0) / 86_400); if (index < 0 || index >= safeDays) continue; lifecycle[state].trend[index].value += value;
  }
  for (const row of deliveryRows) {
    const state = String(row?.state || "").toLowerCase(); const measuredAt = Number(row.measured_at); const value = Number(row.count);
    if (!LIFECYCLE_STATES.includes(state) || !Number.isFinite(measuredAt) || !Number.isFinite(value)) continue;
    const index = Math.floor((measuredAt - day0) / 86_400); if (index < 0 || index >= safeDays) continue;
    const point = delivery[state].trend[index]; const result = String(row.result || "").toLowerCase(); const detail = String(row.detail || "").toLowerCase();
    if (result === "sent") point.sent += value; else if (result === "skipped" && (detail === "disabled" || detail.startsWith("policy_"))) point.policySkipped += value; else if (result === "skipped" && detail === "duplicate_batch_signal") point.duplicateSuppressed += value; else point.issues += value;
  }
  let overallLatency = { sampleSize: 0, medianSeconds: null, p95Seconds: null };
  for (const row of latencyRows) {
    const state = String(row?.state || "").toLowerCase(); const sampleSize = Number(row.sample_size) || 0; const medianSeconds = row.median_seconds == null ? null : Number(row.median_seconds); const p95Seconds = row.p95_seconds == null ? null : Number(row.p95_seconds);
    if (state === "__all__") { overallLatency = { sampleSize, medianSeconds, p95Seconds }; continue; }
    if (!LIFECYCLE_STATES.includes(state)) continue; delivery[state].latencySampleSize = sampleSize; delivery[state].medianLatencySeconds = Number.isFinite(medianSeconds) ? medianSeconds : null; delivery[state].p95LatencySeconds = Number.isFinite(p95Seconds) ? p95Seconds : null;
  }
  for (const state of LIFECYCLE_STATES) {
    lifecycle[state].total = lifecycle[state].trend.reduce((sum, point) => sum + point.value, 0); lifecycle[state].today = lifecycle[state].trend.at(-1)?.value ?? 0;
    delivery[state].sent = delivery[state].trend.reduce((sum, point) => sum + point.sent, 0); delivery[state].policySkipped = delivery[state].trend.reduce((sum, point) => sum + point.policySkipped, 0); delivery[state].duplicateSuppressed = delivery[state].trend.reduce((sum, point) => sum + point.duplicateSuppressed, 0); delivery[state].issues = delivery[state].trend.reduce((sum, point) => sum + point.issues, 0); delivery[state].todaySent = delivery[state].trend.at(-1)?.sent ?? 0;
  }
  return { available: true, generatedAt: now, days: safeDays, day0, lifecycle, delivery, diagnostics: { absentLifecycleStages: LIFECYCLE_STATES.filter((state) => lifecycle[state].total === 0), duplicateSignalsSuppressed: LIFECYCLE_STATES.reduce((sum, state) => sum + delivery[state].duplicateSuppressed, 0), discordDeliveryIssues: LIFECYCLE_STATES.reduce((sum, state) => sum + delivery[state].issues, 0), discordLatency: overallLatency, reliability: reliabilityDiagnostics({ orphanRows, freshnessRows, now }), monitors: monitorDiagnostics(monitorRows), discovery: discoveryDiagnostics(discoveryRows) } };
}

export async function loadSignalHealthSummary(store, { days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!store || typeof store.pool !== "function") return { available: false, reason: "persistent_store_unavailable", generatedAt: now };
  const { safeDays, day0 } = safeWindow(days, now); const pool = await store.pool(); const reliabilitySince = Math.max(0, now - RELIABILITY_LOOKBACK_SECONDS); const orphanBefore = Math.max(0, now - ORPHAN_GRACE_SECONDS);
  const [detections, deliveries, latency, orphans, freshness, discovery, rawMonitors] = await Promise.all([
    pool.query(`SELECT s.state,(FLOOR(s.detected_at / 86400.0) * 86400)::bigint AS measured_at,COUNT(*)::int AS count FROM fatedrop_signals s WHERE s.detected_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished') AND ${publicSignalSqlFilter("s")} AND ${validVanishedSqlFilter("s")} GROUP BY s.state,measured_at ORDER BY measured_at ASC`, [day0]),
    pool.query(`SELECT s.state,(FLOOR(a.attempted_at / 86400.0) * 86400)::bigint AS measured_at,a.result,COALESCE(a.detail,'') AS detail,COUNT(*)::int AS count FROM fatedrop_signal_delivery_attempts a INNER JOIN fatedrop_signals s ON s.id=a.signal_id WHERE a.attempted_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished') AND ${publicSignalSqlFilter("s")} AND ${validVanishedSqlFilter("s")} GROUP BY s.state,measured_at,a.result,a.detail ORDER BY measured_at ASC`, [day0]),
    pool.query(`SELECT COALESCE(state,'__all__') AS state,COUNT(*)::int AS sample_size, percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_seconds)::numeric AS median_seconds, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_seconds)::numeric AS p95_seconds FROM (SELECT s.state,(a.attempted_at-s.detected_at)::numeric AS latency_seconds FROM fatedrop_signal_delivery_attempts a INNER JOIN fatedrop_signals s ON s.id=a.signal_id WHERE a.attempted_at >= $1 AND a.result='sent' AND a.channel='discord' AND a.attempted_at >= s.detected_at AND s.state IN ('whisper','echo','manifested','vanished') AND ${publicSignalSqlFilter("s")} AND ${validVanishedSqlFilter("s")}) sent GROUP BY GROUPING SETS ((state),())`, [day0]),
    pool.query(`SELECT s.id,s.state,s.retailer_id,s.retailer_name,s.title,s.detected_at,COUNT(*) OVER()::int AS orphan_total FROM fatedrop_signals s WHERE s.detected_at >= $1 AND s.detected_at <= $2 AND s.state IN ('whisper','echo','manifested','vanished') AND ${validVanishedSqlFilter("s")} AND ${discordEligibleSignalSqlFilter("s")} AND NOT EXISTS (SELECT 1 FROM fatedrop_signal_delivery_attempts a WHERE a.signal_id=s.id AND a.channel='discord') ORDER BY s.detected_at ASC LIMIT 100`, [reliabilitySince, orphanBefore]),
    pool.query(`SELECT (SELECT MAX(s.detected_at) FROM fatedrop_signals s WHERE s.detected_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished') AND ${validVanishedSqlFilter("s")} AND ${discordEligibleSignalSqlFilter("s")}) AS latest_signal_at, (SELECT MAX(a.attempted_at) FROM fatedrop_signal_delivery_attempts a INNER JOIN fatedrop_signals s ON s.id=a.signal_id WHERE a.attempted_at >= $1 AND a.channel='discord' AND ${validVanishedSqlFilter("s")} AND ${discordEligibleSignalSqlFilter("s")}) AS latest_discord_attempt_at, (SELECT COUNT(*)::int FROM fatedrop_signals s WHERE s.detected_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished') AND ${validVanishedSqlFilter("s")} AND ${discordEligibleSignalSqlFilter("s")}) AS recent_signals, (SELECT COUNT(*)::int FROM fatedrop_signal_delivery_attempts a INNER JOIN fatedrop_signals s ON s.id=a.signal_id WHERE a.attempted_at >= $1 AND a.channel='discord' AND ${validVanishedSqlFilter("s")} AND ${discordEligibleSignalSqlFilter("s")}) AS recent_discord_attempts`, [reliabilitySince]),
    pool.query(`SELECT TRUE AS discovery_available,
      COUNT(*) FILTER (WHERE COALESCE(evidence->'canonical_pipeline'->>'status','pending')='pending')::int AS pending,
      COUNT(*) FILTER (WHERE evidence->'canonical_pipeline'->>'status'='retry')::int AS retry,
      COUNT(*) FILTER (WHERE evidence->'canonical_pipeline'->>'status'='processed')::int AS processed,
      COUNT(*) FILTER (WHERE evidence->'canonical_pipeline'->>'status'='failed')::int AS failed,
      MAX(observed_at)::bigint AS latest_observed_at,
      MAX(NULLIF(evidence->'canonical_pipeline'->>'processedAt','')::bigint) FILTER (WHERE evidence->'canonical_pipeline'->>'status'='processed') AS latest_processed_at,
      (MIN(observed_at) FILTER (WHERE COALESCE(evidence->'canonical_pipeline'->>'status','pending') IN ('pending','retry')))::bigint AS oldest_active_at
      FROM fatedrop_retailer_discovery_evidence
      WHERE source_type='product_discovery_watch'`).catch(() => ({ rows: [{ discovery_available: false }] })),
    typeof store.listRetailers === "function" ? store.listRetailers().catch(() => []) : [],
  ]);
  return buildSignalHealthSummary({ detectionRows: detections.rows, deliveryRows: deliveries.rows, latencyRows: latency.rows, orphanRows: orphans.rows, freshnessRows: freshness.rows, discoveryRows: discovery.rows, monitorRows: rawMonitors, days: safeDays, now });
}
