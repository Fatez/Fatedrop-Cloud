import { classifyRetailerFailure } from "./retailer-failure-classification.mjs";

export function retailerFailureBackoffDecision({ retailer, health, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!retailer?.id || !health || health.healthy !== false) {
    return { defer: false, failureClass: "none", backoffSeconds: 0, retryAt: null };
  }

  const classification = classifyRetailerFailure({
    failureCode: health.failureCode,
    lastError: health.lastError,
    stale: health.stale === true,
  });
  const lastFailureAt = Number(health.lastScanAt || 0);
  const backoffSeconds = Number(classification.backoffSeconds || 0);
  const retryAt = lastFailureAt > 0 && backoffSeconds > 0
    ? lastFailureAt + backoffSeconds
    : null;

  return {
    defer: retryAt != null && Number(now) < retryAt,
    failureClass: classification.failureClass,
    failureCode: classification.failureCode,
    backoffSeconds,
    recoveryAction: classification.recoveryAction,
    retryAt,
  };
}
