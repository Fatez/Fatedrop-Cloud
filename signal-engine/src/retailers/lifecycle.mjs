import { RETAILER_STATES, normalizeRetailerCandidate } from "./registry.mjs";

const allowedTransitions = Object.freeze({
  [RETAILER_STATES.CANDIDATE]: new Set([RETAILER_STATES.QUALIFYING, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.QUALIFYING]: new Set([RETAILER_STATES.READY, RETAILER_STATES.PAUSED, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.READY]: new Set([RETAILER_STATES.MONITORED, RETAILER_STATES.PAUSED, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.MONITORED]: new Set([RETAILER_STATES.PAUSED]),
  [RETAILER_STATES.PAUSED]: new Set([RETAILER_STATES.QUALIFYING, RETAILER_STATES.READY, RETAILER_STATES.MONITORED, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.REJECTED]: new Set([RETAILER_STATES.CANDIDATE]),
});

function readinessFailures(retailer, evidence = {}) {
  const failures = [];
  if (!retailer.catalogue.urls.length && !retailer.catalogue.feedUrl) failures.push("catalogue-entrypoint-required");
  if (!evidence.adapterQualified) failures.push("adapter-qualification-required");
  if (!evidence.dryRunComplete) failures.push("successful-dry-run-required");
  if (!evidence.catalogueComplete) failures.push("complete-catalogue-proof-required");
  if (!evidence.stockMappingValidated) failures.push("stock-mapping-validation-required");
  return failures;
}

export function validateRetailerTransition(input, nextState, evidence = {}) {
  const retailer = normalizeRetailerCandidate(input);
  if (!Object.values(RETAILER_STATES).includes(nextState)) return { allowed: false, reasons: ["invalid-target-state"], retailer };
  if (retailer.state === nextState) return { allowed: true, reasons: [], retailer };
  const allowed = allowedTransitions[retailer.state] || new Set();
  const reasons = [];
  if (!allowed.has(nextState)) reasons.push(`transition-not-allowed:${retailer.state}->${nextState}`);
  if (nextState === RETAILER_STATES.READY || nextState === RETAILER_STATES.MONITORED) reasons.push(...readinessFailures(retailer, evidence));
  if (nextState === RETAILER_STATES.MONITORED && evidence.explicitMonitoringApproval !== true) reasons.push("explicit-monitoring-approval-required");
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)], retailer };
}

export function transitionRetailer(input, nextState, evidence = {}) {
  const result = validateRetailerTransition(input, nextState, evidence);
  if (!result.allowed) throw new Error(`Retailer transition blocked: ${result.reasons.join(", ")}`);
  return normalizeRetailerCandidate({ ...result.retailer, state: nextState });
}
