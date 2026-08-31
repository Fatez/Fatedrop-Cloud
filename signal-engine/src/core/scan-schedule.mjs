import { classifyRetailerFailure } from "./retailer-failure-classification.mjs";

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
  const failure = classifyRetailerFailure(health);
  const intervalSeconds = healthy ? normalInterval : Math.max(normalInterval, failure.backoffSeconds);
  const nextScanAt = lastScanAt > 0 ? lastScanAt + intervalSeconds : 0;
  const eligible = !lastScanAt || now >= nextScanAt;

  return {
    eligible,
    intervalSeconds,
    nextScanAt: eligible ? null : nextScanAt,
    reason: eligible ? null : healthy ? "retailer_scan_interval" : "retailer_failure_backoff",
    failureClass: healthy ? "none" : failure.failureClass,
    recoveryAction: healthy ? "normal_scan" : failure.recoveryAction,
  };
}
