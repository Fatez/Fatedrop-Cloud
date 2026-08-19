import { ADAPTER_TYPES, RETAILER_CLASSES, RETAILER_STATES, normalizeRetailerCandidate, qualifyRetailer } from "./registry.mjs";

export function inferAdapterFromEvidence({ platform = "", feedUrls = [], html = "" } = {}) {
  const evidence = `${platform} ${feedUrls.join(" ")} ${html}`.toLowerCase();
  if (/shopify|cdn\.shopify|myshopify/.test(evidence)) return ADAPTER_TYPES.SHOPIFY;
  if (/woocommerce|wp-content|wc-ajax/.test(evidence)) return ADAPTER_TYPES.WOOCOMMERCE;
  if (/\.csv(?:\?|$)|text\/csv|csv feed/.test(evidence)) return ADAPTER_TYPES.CSV;
  if (/\.json(?:\?|$)|application\/json|xml feed|\.xml(?:\?|$)/.test(evidence)) return ADAPTER_TYPES.STRUCTURED_FEED;
  return ADAPTER_TYPES.GENERIC_HTML;
}

export function monitoringPolicyFor(retailer) {
  const item = normalizeRetailerCandidate(retailer);
  const byClass = {
    [RETAILER_CLASSES.NATIONAL]: 60,
    [RETAILER_CLASSES.SPECIALIST]: 90,
    [RETAILER_CLASSES.REGIONAL]: 180,
    [RETAILER_CLASSES.INDEPENDENT]: 300,
    [RETAILER_CLASSES.EVENT_VENDOR]: 300,
  };
  const cadenceSeconds = Math.max(60, item.monitoring.cadenceSeconds || byClass[item.retailerClass] || 300);
  return {
    cadenceSeconds,
    timeoutSeconds: Math.min(45, Math.max(10, Math.floor(cadenceSeconds / 4))),
    retries: item.retailerClass === RETAILER_CLASSES.NATIONAL ? 2 : 1,
    allowIncompleteReplacement: false,
    alertAfterConsecutiveFailures: item.retailerClass === RETAILER_CLASSES.NATIONAL ? 2 : 3,
  };
}

export function onboardingPlan(input) {
  const qualification = qualifyRetailer(input);
  const retailer = qualification.retailer;
  const tasks = [];
  if (!qualification.eligible) {
    return { retailer, state: RETAILER_STATES.CANDIDATE, readyForMonitoring: false, blockers: qualification.reasons, tasks };
  }
  if (retailer.verification === "unverified") tasks.push("verify-business-identity");
  if (!retailer.delivery.known) tasks.push("capture-delivery-policy");
  if (retailer.rrpAuthority === "none") tasks.push("attach-independent-rrp-provenance");
  if (!retailer.catalogue.platformEvidence.length) tasks.push("confirm-platform-adapter");
  tasks.push("dry-run-catalogue");
  tasks.push("validate-product-count");
  tasks.push("validate-stock-mapping");
  tasks.push("enable-health-monitoring");
  return {
    retailer,
    state: tasks.length ? RETAILER_STATES.QUALIFYING : RETAILER_STATES.READY,
    readyForMonitoring: false,
    blockers: [],
    tasks,
    monitoringPolicy: monitoringPolicyFor(retailer),
  };
}

export function shouldPublishCatalogue({ previousCompleteCount = null, observedCount = 0, expectedMinimumProducts = null, explicitlyComplete = false } = {}) {
  if (!explicitlyComplete) return { publish: false, reason: "scan-not-confirmed-complete" };
  if (!Number.isFinite(observedCount) || observedCount <= 0) return { publish: false, reason: "empty-catalogue" };
  if (Number.isFinite(expectedMinimumProducts) && observedCount < expectedMinimumProducts) return { publish: false, reason: "below-expected-minimum" };
  if (Number.isFinite(previousCompleteCount) && previousCompleteCount > 20 && observedCount < Math.floor(previousCompleteCount * 0.65)) return { publish: false, reason: "suspicious-catalogue-collapse" };
  return { publish: true, reason: "complete" };
}
