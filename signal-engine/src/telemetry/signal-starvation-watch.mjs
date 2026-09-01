const DEFAULT_WARNING_SECONDS = 6 * 60 * 60;
const DEFAULT_CRITICAL_SECONDS = 12 * 60 * 60;
const RELIABILITY_LOOKBACK_SECONDS = 24 * 60 * 60;

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function timestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function classifySignalStarvation(summary, {
  now = null,
  warningSeconds = DEFAULT_WARNING_SECONDS,
  criticalSeconds = DEFAULT_CRITICAL_SECONDS,
} = {}) {
  if (summary?.available !== true) {
    return {
      status: "unknown",
      shouldAlert: false,
      reason: "signal_summary_unavailable",
    };
  }

  const explicitNow = now == null ? null : Number(now);
  const generatedAt = explicitNow != null && Number.isFinite(explicitNow)
    ? explicitNow
    : Math.floor(Date.parse(String(summary.generatedAt || "")) / 1000);
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) {
    return {
      status: "unknown",
      shouldAlert: false,
      reason: "signal_summary_timestamp_invalid",
    };
  }

  const diagnostics = summary.diagnostics || {};
  const reliability = diagnostics.reliability || {};
  const monitors = diagnostics.monitors || {};
  const activeRetailers = count(monitors.activeRetailers);
  const freshRetailers = count(monitors.freshRetailers);
  const blockedRetailers = count(monitors.blockedRetailers);
  const degradedRetailers = count(monitors.degradedRetailers);
  const recentSignals = count(reliability.recentSignals);
  const latestSignalAt = timestamp(reliability.latestSignalAt);
  const freshCoverage = ratio(freshRetailers, activeRetailers);
  const blockedCoverage = ratio(blockedRetailers, activeRetailers);
  const degradedCoverage = ratio(degradedRetailers, activeRetailers);

  const coverageEvidence = activeRetailers >= 5 && (
    (freshRetailers >= 3 && freshCoverage >= 0.35)
    || blockedCoverage >= 0.20
    || degradedCoverage >= 0.35
  );

  const silenceSeconds = latestSignalAt == null
    ? (recentSignals === 0 ? RELIABILITY_LOOKBACK_SECONDS : null)
    : Math.max(0, generatedAt - latestSignalAt);

  if (!coverageEvidence || silenceSeconds == null) {
    return {
      status: "healthy",
      shouldAlert: false,
      reason: coverageEvidence ? "signal_age_unavailable" : "insufficient_monitor_coverage_for_starvation_claim",
      silenceSeconds,
      activeRetailers,
      freshRetailers,
      blockedRetailers,
      degradedRetailers,
      freshCoverage,
      blockedCoverage,
      degradedCoverage,
      latestSignalAt,
      recentSignals,
    };
  }

  const safeWarningSeconds = Math.max(60 * 60, Number(warningSeconds) || DEFAULT_WARNING_SECONDS);
  const safeCriticalSeconds = Math.max(safeWarningSeconds, Number(criticalSeconds) || DEFAULT_CRITICAL_SECONDS);
  let status = "healthy";
  if (silenceSeconds >= safeCriticalSeconds) status = "critical";
  else if (silenceSeconds >= safeWarningSeconds) status = "warning";

  const reason = status === "healthy"
    ? "signal_activity_within_slo"
    : freshRetailers >= 3 && freshCoverage >= 0.35
      ? "signal_starvation_despite_fresh_monitor_coverage"
      : "signal_starvation_with_monitor_degradation";

  return {
    status,
    shouldAlert: status === "warning" || status === "critical",
    reason,
    silenceSeconds,
    warningSeconds: safeWarningSeconds,
    criticalSeconds: safeCriticalSeconds,
    activeRetailers,
    freshRetailers,
    blockedRetailers,
    degradedRetailers,
    freshCoverage,
    blockedCoverage,
    degradedCoverage,
    latestSignalAt,
    recentSignals,
  };
}
