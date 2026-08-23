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
    issues: 0,
    todaySent: 0,
    trend: Array.from({ length: days }, (_, index) => ({ measuredAt: day0 + (index * 86_400), sent: 0, policySkipped: 0, issues: 0 })),
  }]));
}

export function buildSignalHealthSummary({ detectionRows = [], deliveryRows = [], days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
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
    else point.issues += value;
  }

  for (const state of LIFECYCLE_STATES) {
    lifecycle[state].total = lifecycle[state].trend.reduce((sum, point) => sum + point.value, 0);
    lifecycle[state].today = lifecycle[state].trend.at(-1)?.value ?? 0;
    delivery[state].sent = delivery[state].trend.reduce((sum, point) => sum + point.sent, 0);
    delivery[state].policySkipped = delivery[state].trend.reduce((sum, point) => sum + point.policySkipped, 0);
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
  };
}

export async function loadSignalHealthSummary(store, { days = 7, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!store || typeof store.pool !== "function") {
    return { available: false, reason: "persistent_store_unavailable", generatedAt: now };
  }
  const { safeDays, day0 } = safeWindow(days, now);
  const pool = await store.pool();
  const [detections, deliveries] = await Promise.all([
    pool.query(`SELECT state,(FLOOR(detected_at / 86400.0) * 86400)::bigint AS measured_at,COUNT(*)::int AS count
      FROM fatedrop_signals
      WHERE detected_at >= $1 AND state IN ('whisper','echo','manifested','vanished')
      GROUP BY state,measured_at ORDER BY measured_at ASC`, [day0]),
    pool.query(`SELECT s.state,(FLOOR(a.attempted_at / 86400.0) * 86400)::bigint AS measured_at,a.result,COALESCE(a.detail,'') AS detail,COUNT(*)::int AS count
      FROM fatedrop_signal_delivery_attempts a
      INNER JOIN fatedrop_signals s ON s.id=a.signal_id
      WHERE a.attempted_at >= $1 AND s.state IN ('whisper','echo','manifested','vanished')
      GROUP BY s.state,measured_at,a.result,a.detail ORDER BY measured_at ASC`, [day0]),
  ]);
  return buildSignalHealthSummary({ detectionRows: detections.rows, deliveryRows: deliveries.rows, days: safeDays, now });
}
