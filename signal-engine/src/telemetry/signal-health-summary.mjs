const LIFECYCLE_STATES = ["whisper", "echo", "manifested", "vanished"];

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
  return Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, {
    total: 0,
    today: 0,
    trend: Array.from({ length: days }, (_, index) => ({ measuredAt: day0 + (index * 86_400), value: 0 })),
  }]));
}

function emptyDelivery(day0, days) {
  return Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, {
    sent: 0,
    policySkipped: 0,
    duplicateSuppressed: 0,
    issues: 0,
    todaySent: 0,
    latencySampleSize: 0,
    medianLatencySeconds: null,
    p95LatencySeconds: null,
    trend: Array.from({ length: days }, (_, index) => ({ measuredAt: day0 + (index * 86_400), sent: 0, policySkipped: 0, duplicateSuppressed: 0, issues: 0 })),
  }]));
}

function monitorDiagnostics(monitorRows = []) {
  const rows = Array.isArray(monitorRows) ? monitorRows : [];
  const stale = rows.filter((row) => row?.stale === true);
  const unhealthy = rows.filter((row) => row?.healthy !== true && row?.stale !== true);
  const blocked = rows.filter((row) => /\b403\b|blocked/i.test(String(row?.lastError || "")));
  const fresh = rows.filter((row) => row?.healthy === true && row?.stale !== true);
  return {
    totalRetailers: rows.length,
    freshRetailers: fresh.length,
    staleRetailers: stale.length,
    unhealthyRetailers: unhealthy.length,
    blockedRetailers: blocked.length,
    staleRetailerIds: stale.map((row) => row.id),
    unhealthyRetailerIds: unhealthy.map((row) => row.id),
    blockedRetailerIds: blocked.map((row) => row.id),
  };
}

export function buildSignalHealthSummary({ detectionRows = [], deliveryRows = [], latencyRows = [], monitorRows = [], days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
  const { safeDays, day0 } = safeWindow(days, now);
  const lifecycle = emptyLifecycle(day0, safeDays);
  const delivery = emptyDelivery(day0, safeDays);

  for (const row of detectionRows) {
    const state = String(row?.state || "").toLowerCase();
    if (!LIFECYCLE_STATES.includes(state)) continue;
    const measuredAt = Number(row.measured_at);
    const value = Number(row.count);
    if (!Number.isFinite(measuredAt) || !Number.isFinite(value)) continue;
    const index = Math.floor((measuredAt - day0) / 86_400);
    if (index < 0 || index >= safeDays) continue;
    lifecycle[state].trend[index].value += value;
  }

  for (const row of deliveryRows) {
    const state = String(row?.state || "").toLowerCase();
    if (!LIFECYCLE_STATES.includes(state)) continue;
    const measuredAt = Number(row.measured_at);
    const value = Number(row.count);
    if (!Number.isFinite(measuredAt) || !Number.isFinite(value)) continue;
    const index = Math.floor((measuredAt - day0) / 86_400);
    if (index < 0 || index >= safeDays) continue;
    const point = delivery[state].trend[index];
    const result = String(row.result || "").toLowerCase();
    const detail = String(row.detail || "").toLowerCase();
    if (result === "sent") point.sent += value;
    else if (result === "skipped" && detail === "disabled") point.policySkipped += value;
    else if (result === "skipped" && detail === "duplicate_batch_signal") point.duplicateSuppressed += value;
    else point.issues += value;
  }

  let overallLatency = { sampleSize: 0, medianSeconds: null, p95Seconds: null };
  for (const row of latencyRows) {
    const state = String(row?.state || "").toLowerCase();
    const sampleSize = Number(row.sample_size) || 0;
    const medianSeconds = row.median_seconds == null ? null : Number(row.median_seconds);
    const p95Seconds = row.p95_seconds == null ? null : Number(row.p95_seconds);
    if (state === "__all__") {
      overallLatency = { sampleSize, medianSeconds, p95Seconds };
      continue;
    }
    if (!LIFECYCLE_STATES.includes(state)) continue;
    delivery[state].latencySampleSize = sampleSize;
    delivery[state].medianLatencySeconds = Number.isFinite(medianSeconds) ? medianSeconds : null;
    delivery[state].p95LatencySeconds = Number.isFinite(p95Seconds) ? p95Seconds : null;
  }

  for (const state of LIFECYCLE_STATES) {
    lifecycle[state].total = lifecycle[state].trend.reduce((sum, point) => sum + point.value, 0);
    lifecycle[state].today = lifecycle[state].trend.at(-1)?.value ?? 0;
    delivery[state].sent = delivery[state].trend.reduce((sum, point) => sum + point.sent, 0);
    delivery[state].policySkipped = delivery[state].trend.reduce((sum, point) => sum + point.policySkipped, 0);
    delivery[state].duplicateSuppressed = delivery[state].trend.reduce((sum, point) => sum + point.duplicateSuppressed, 0);
    delivery[state].issues = delivery[state].trend.reduce((sum, point) => sum + point.issues, 0);
    delivery[state].todaySent = delivery[state].trend.at(-1)?.sent ?? 0;
  }

  return {
    available: true,
    generatedAt: now,
    days: safeDays,
    day0,
    lifecycle,
    delivery,
    diagnostics: {
      absentLifecycleStages: LIFECYCLE_STATES.filter((state) => lifecycle[state].total === 0),
      duplicateSignalsSuppressed: LIFECYCLE_STATES.reduce((sum, state) => sum + delivery[state].duplicateSuppressed, 0),
      discordDeliveryIssues: LIFECYCLE_STATES.reduce((sum, state) => sum + delivery[state].issues, 0),
      discordLatency: overallLatency,
      monitors: monitorDiagnostics(monitorRows),
    },
  };
}

export async function loadSignalHealthSummary(store, { days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!store || typeof store.pool !== "function") {
    return { available: false, reason: "persistent_store_unavailable", generatedAt: now };
  }
  const { safeDays, day0 } = safeWindow(days, now);
  const pool = await store.pool();
  const [detections, deliveries, latency, monitorRows] = await Promise.all([
    pool.query(`SELECT s.state,(FLOOR(s.detected_at / 86400.0) * 86400)::bigint AS measured_at,COUNT(*)::int AS count
      FROM fatedrop_signals s
      WHERE s.detected_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished')
        AND (
          s.state <> 'vanished'
          OR (
            s.offer_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM fatedrop_signals m
              WHERE m.offer_id=s.offer_id AND m.state='manifested' AND m.detected_at < s.detected_at
                AND NOT EXISTS (
                  SELECT 1 FROM fatedrop_signals v
                  WHERE v.offer_id=s.offer_id AND v.state='vanished'
                    AND v.detected_at > m.detected_at AND v.detected_at < s.detected_at
                )
            )
          )
        )
      GROUP BY s.state,measured_at ORDER BY measured_at ASC`, [day0]),
    pool.query(`SELECT s.state,(FLOOR(a.attempted_at / 86400.0) * 86400)::bigint AS measured_at,a.result,COALESCE(a.detail,'') AS detail,COUNT(*)::int AS count
      FROM fatedrop_signal_delivery_attempts a
      INNER JOIN fatedrop_signals s ON s.id=a.signal_id
      WHERE a.attempted_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished')
        AND (
          s.state <> 'vanished'
          OR (
            s.offer_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM fatedrop_signals m
              WHERE m.offer_id=s.offer_id AND m.state='manifested' AND m.detected_at < s.detected_at
                AND NOT EXISTS (
                  SELECT 1 FROM fatedrop_signals v
                  WHERE v.offer_id=s.offer_id AND v.state='vanished'
                    AND v.detected_at > m.detected_at AND v.detected_at < s.detected_at
                )
            )
          )
        )
      GROUP BY s.state,measured_at,a.result,a.detail ORDER BY measured_at ASC`, [day0]),
    pool.query(`SELECT COALESCE(state,'__all__') AS state,COUNT(*)::int AS sample_size,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_seconds)::numeric AS median_seconds,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_seconds)::numeric AS p95_seconds
      FROM (
        SELECT s.state,(a.attempted_at-s.detected_at)::numeric AS latency_seconds
        FROM fatedrop_signal_delivery_attempts a
        INNER JOIN fatedrop_signals s ON s.id=a.signal_id
        WHERE a.attempted_at >= $1 AND a.result='sent' AND a.channel='discord'
          AND a.attempted_at >= s.detected_at
          AND s.state IN ('whisper','echo','manifested','vanished')
          AND (
            s.state <> 'vanished'
            OR (
              s.offer_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM fatedrop_signals m
                WHERE m.offer_id=s.offer_id AND m.state='manifested' AND m.detected_at < s.detected_at
                  AND NOT EXISTS (
                    SELECT 1 FROM fatedrop_signals v
                    WHERE v.offer_id=s.offer_id AND v.state='vanished'
                      AND v.detected_at > m.detected_at AND v.detected_at < s.detected_at
                  )
              )
            )
          )
      ) sent
      GROUP BY GROUPING SETS ((state),())`, [day0]),
    typeof store.listRetailers === "function" ? store.listRetailers() : [],
  ]);
  return buildSignalHealthSummary({
    detectionRows: detections.rows,
    deliveryRows: deliveries.rows,
    latencyRows: latency.rows,
    monitorRows,
    days: safeDays,
    now,
  });
}
