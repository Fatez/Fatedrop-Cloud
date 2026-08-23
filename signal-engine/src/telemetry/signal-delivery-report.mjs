const LIFECYCLE_STATES = Object.freeze(["whisper", "echo", "manifested", "vanished"]);

function emptyState() {
  return { detected: 0, attempted: 0, sent: 0, skipped: 0, failed: 0, unaccounted: 0, deliveryRatePercent: 0 };
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRow(row = {}) {
  const detected = numeric(row.detected);
  const attempted = numeric(row.attempted);
  const sent = numeric(row.sent);
  const skipped = numeric(row.skipped);
  const failed = numeric(row.failed);
  const unaccounted = numeric(row.unaccounted);
  return {
    detected,
    attempted,
    sent,
    skipped,
    failed,
    unaccounted,
    deliveryRatePercent: detected > 0 ? Math.round((sent / detected) * 1000) / 10 : 0,
  };
}

export function flattenSignalDeliveryMetrics(report) {
  if (!report?.available) return {};
  const output = {
    discordDetected: 0,
    discordAttempted: 0,
    discordDelivered: 0,
    discordSkipped: 0,
    discordFailed: 0,
    discordUnaccounted: 0,
  };
  for (const state of LIFECYCLE_STATES) {
    const stats = report.byState?.[state] || emptyState();
    const prefix = state;
    output[`${prefix}Delivered`] = stats.sent;
    output[`${prefix}Skipped`] = stats.skipped;
    output[`${prefix}Failed`] = stats.failed;
    output[`${prefix}Unaccounted`] = stats.unaccounted;
    output.discordDetected += stats.detected;
    output.discordAttempted += stats.attempted;
    output.discordDelivered += stats.sent;
    output.discordSkipped += stats.skipped;
    output.discordFailed += stats.failed;
    output.discordUnaccounted += stats.unaccounted;
  }
  return output;
}

export async function buildSignalDeliveryReport(store, {
  since = Math.floor(Date.now() / 1000) - 86_400,
  until = Math.floor(Date.now() / 1000) + 1,
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { available: false, reason: "store_not_persistent", since, until, byState: null, totals: null };
  }

  const pool = await store.pool();
  const { rows } = await pool.query(`
    WITH scoped_signals AS (
      SELECT id, state
      FROM fatedrop_signals
      WHERE detected_at >= $1
        AND detected_at < $2
        AND state = ANY($3)
    ), reconciled AS (
      SELECT
        signal.id,
        signal.state,
        delivery.result
      FROM scoped_signals signal
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN bool_or(attempt.result = 'sent') THEN 'sent'
          ELSE (array_agg(attempt.result ORDER BY attempt.attempted_at DESC, attempt.id DESC))[1]
        END AS result
        FROM fatedrop_signal_delivery_attempts attempt
        WHERE attempt.signal_id = signal.id
          AND attempt.channel = 'discord'
      ) delivery ON TRUE
    )
    SELECT
      state,
      count(*)::int AS detected,
      count(result)::int AS attempted,
      count(*) FILTER (WHERE result = 'sent')::int AS sent,
      count(*) FILTER (WHERE result = 'skipped')::int AS skipped,
      count(*) FILTER (WHERE result = 'failed')::int AS failed,
      count(*) FILTER (WHERE result IS NULL)::int AS unaccounted
    FROM reconciled
    GROUP BY state
    ORDER BY state
  `, [Math.floor(since), Math.floor(until), LIFECYCLE_STATES]);

  const byState = Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, emptyState()]));
  for (const row of rows || []) {
    if (!LIFECYCLE_STATES.includes(row.state)) continue;
    byState[row.state] = normalizeRow(row);
  }

  const totals = Object.values(byState).reduce((acc, stats) => {
    acc.detected += stats.detected;
    acc.attempted += stats.attempted;
    acc.sent += stats.sent;
    acc.skipped += stats.skipped;
    acc.failed += stats.failed;
    acc.unaccounted += stats.unaccounted;
    return acc;
  }, emptyState());
  totals.deliveryRatePercent = totals.detected > 0 ? Math.round((totals.sent / totals.detected) * 1000) / 10 : 0;

  return { available: true, since: Math.floor(since), until: Math.floor(until), byState, totals };
}
