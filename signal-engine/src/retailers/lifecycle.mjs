import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "./registry.mjs";

const allowedTransitions = Object.freeze({
  [RETAILER_STATES.CANDIDATE]: new Set([RETAILER_STATES.QUALIFYING, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.QUALIFYING]: new Set([RETAILER_STATES.READY, RETAILER_STATES.PAUSED, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.READY]: new Set([RETAILER_STATES.MONITORED, RETAILER_STATES.PAUSED, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.MONITORED]: new Set([RETAILER_STATES.PAUSED]),
  [RETAILER_STATES.PAUSED]: new Set([RETAILER_STATES.QUALIFYING, RETAILER_STATES.READY, RETAILER_STATES.MONITORED, RETAILER_STATES.REJECTED]),
  [RETAILER_STATES.REJECTED]: new Set([RETAILER_STATES.CANDIDATE]),
});

function adapterRuntimeFailures(retailer) {
  const failures = [];
  if ([ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    if (!retailer.catalogue.feedUrl) failures.push("structured-feed-url-required");
    if (retailer.catalogue.feedApproved !== true) failures.push("structured-feed-approval-required");
  }
  if (retailer.adapterType === ADAPTER_TYPES.GENERIC_HTML) {
    if (!retailer.catalogue.urls.length) failures.push("html-catalogue-url-required");
    if (!retailer.catalogue.runtime.productUrlPattern) failures.push("product-url-pattern-required");
    if (!retailer.catalogue.runtime.skuPattern) failures.push("sku-pattern-required");
  }
  if ([ADAPTER_TYPES.BROWSER_COLLECTOR, ADAPTER_TYPES.CSV, ADAPTER_TYPES.MANUAL, ADAPTER_TYPES.STRUCTURED_FEED].includes(retailer.adapterType)) {
    failures.push("adapter-runtime-not-enabled");
  }
  return failures;
}

function readinessFailures(retailer, evidence = {}) {
  const failures = [];
  if (!retailer.catalogue.urls.length && !retailer.catalogue.feedUrl) failures.push("catalogue-entrypoint-required");
  failures.push(...adapterRuntimeFailures(retailer));
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
