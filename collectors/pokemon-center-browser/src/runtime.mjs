export const BrowserState = Object.freeze({
  NORMAL: "normal",
  QUEUE: "queue",
  SECURITY: "security",
  ACCESS_BLOCKED: "access_blocked",
  UNEXPECTED: "unexpected",
});

const REPORTABLE_READINESS_STATES = new Set([
  BrowserState.QUEUE,
  BrowserState.SECURITY,
  BrowserState.ACCESS_BLOCKED,
]);

export function remainingCycleDelay({ startedAtMs, nowMs = Date.now(), minimumCycleMs }) {
  return Math.max(0, minimumCycleMs - Math.max(0, nowMs - startedAtMs));
}

export function nextCollectorFailureState({ consecutiveFailures = 0, browserState, maxFailures = 3 } = {}) {
  const safeMaxFailures = Math.max(1, Math.min(10, Number.isFinite(maxFailures) ? Math.trunc(maxFailures) : 3));
  if (browserState !== BrowserState.NORMAL) return { consecutiveFailures: 0, recycle: false };
  const nextFailures = Math.max(0, Math.trunc(consecutiveFailures || 0)) + 1;
  return { consecutiveFailures: nextFailures, recycle: nextFailures >= safeMaxFailures };
}

export function readinessReportTransition({ previousState = null, state } = {}) {
  if (!REPORTABLE_READINESS_STATES.has(state)) return { report: false, previousState: null };
  return { report: true, previousState: previousState ?? "unknown" };
}

export function classifyBrowserState({ url = "", title = "", text = "" } = {}) {
  const sample = `${url}\n${title}\n${text}`.toLowerCase();

  if (/queue-it|waiting room|you are now in line|estimated wait|queue position|virtual queue/.test(sample)) {
    return BrowserState.QUEUE;
  }
  if (/captcha|verify you are human|security check|security verification|challenge-platform|unusual traffic|checking your browser/.test(sample)) {
    return BrowserState.SECURITY;
  }
  if (/access denied|forbidden|request blocked|temporarily blocked|error 403|http 403/.test(sample)) {
    return BrowserState.ACCESS_BLOCKED;
  }
  if (/pokemoncenter\.com/.test(url.toLowerCase())) return BrowserState.NORMAL;
  return BrowserState.UNEXPECTED;
}

export function browserStateLabel(state) {
  switch (state) {
    case BrowserState.QUEUE: return "queue / traffic control detected";
    case BrowserState.SECURITY: return "security verification detected";
    case BrowserState.ACCESS_BLOCKED: return "access block detected";
    case BrowserState.NORMAL: return "normal catalogue access";
    default: return "unexpected browser state";
  }
}
