function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeNotificationReadiness(row = {}, { since, now } = {}) {
  const snapshot = {
    since: Number.isFinite(since) ? Math.floor(since) : null,
    now: Number.isFinite(now) ? Math.floor(now) : null,
    total: numeric(row.total),
    sent: numeric(row.sent),
    suppressed: numeric(row.suppressed),
    pending: numeric(row.pending),
    failed: numeric(row.failed),
    sending: numeric(row.sending),
    overdue: numeric(row.overdue),
    stuckSending: numeric(row.stuck_sending),
  };
  snapshot.ready = snapshot.overdue === 0 && snapshot.stuckSending === 0;
  return snapshot;
}

export async function buildFateMatchNotificationReadiness(pool, {
  now = Math.floor(Date.now() / 1000),
  since = Math.floor(Date.now() / 1000) - 86_400,
  overdueGraceSeconds = 120,
  sendingGraceSeconds = 300,
} = {}) {
  const safeNow = Math.floor(now);
  const safeSince = Math.floor(since);
  const overdueBefore = safeNow - Math.max(0, Math.floor(overdueGraceSeconds));
  const stuckBefore = safeNow - Math.max(0, Math.floor(sendingGraceSeconds));
  const { rows } = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE state='sent')::int AS sent,
      count(*) FILTER (WHERE state='suppressed')::int AS suppressed,
      count(*) FILTER (WHERE state='pending')::int AS pending,
      count(*) FILTER (WHERE state='failed')::int AS failed,
      count(*) FILTER (WHERE state='sending')::int AS sending,
      count(*) FILTER (
        WHERE state IN ('pending','failed')
          AND next_attempt_at <= $2
      )::int AS overdue,
      count(*) FILTER (
        WHERE state='sending'
          AND updated_at <= $3
      )::int AS stuck_sending
    FROM fatedrop_notification_outbox
    WHERE event_type='fate_match'
      AND created_at >= $1
  `, [safeSince, overdueBefore, stuckBefore]);
  return normalizeNotificationReadiness(rows?.[0] || {}, { since: safeSince, now: safeNow });
}
