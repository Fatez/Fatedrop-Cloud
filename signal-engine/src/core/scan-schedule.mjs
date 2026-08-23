const MINUTE = 60;
const HOUR = 60 * MINUTE;

function failureBackoffSeconds(health) {
  const detail = String(health?.lastError || "").toLowerCase();
  if (!detail) return 15 * MINUTE;
  if (/\b403\b|\b401\b|forbidden|access control|access blocked|blocked .*request/.test(detail)) return 6 * HOUR;
  if (/\b429\b|rate.?limit|too many requests/.test(detail)) return 2 * HOUR;
  if (/timed out|timeout/.test(detail)) return 30 * MINUTE;
  if (/safety cap|above safety cap|zero qualifying products|zero qualifying catalogue/.test(detail)) return HOUR;
  return 15 * MINUTE;
}

export function retailerScanScheduleDecision(retailer, health, {
  now = Math.floor(Date.now() / 1000),
  globalIntervalSeconds = 300,
} = {}) {
  const lastScanAt = Number(health?.lastScanAt) || 0;
  const healthy = health?.healthy === true;
  const requestedInterval = Number(retailer?.scanIntervalSeconds);
  const normalInterval = Number.isFinite(requestedInterval)
    ? Math.max(globalIntervalSeconds, Math.round(requestedInterval))
    : globalIntervalSeconds;
  const intervalSeconds = healthy ? normalInterval : Math.max(normalInterval, failureBackoffSeconds(health));
  const nextScanAt = lastScanAt > 0 ? lastScanAt + intervalSeconds : 0;
  const eligible = !lastScanAt || now >= nextScanAt;

  return {
    eligible,
    intervalSeconds,
    nextScanAt: eligible ? null : nextScanAt,
    reason: eligible ? null : healthy ? "retailer_scan_interval" : "retailer_failure_backoff",
  };
}
