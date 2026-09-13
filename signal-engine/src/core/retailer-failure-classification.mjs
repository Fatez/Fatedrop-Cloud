const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const RETAILER_FAILURE_CLASSES = Object.freeze([
  "none",
  "access_blocked",
  "rate_limited",
  "timeout",
  "catalogue_empty",
  "partial_catalogue",
  "parser_regression",
  "stock_selector_changed",
  "identity_resolution",
  "market_conflict",
  "stale_observation",
  "network",
  "configuration",
  "unknown",
]);

const FAILURE_POLICY = Object.freeze({
  none: { backoffSeconds: 0, recoveryAction: "normal_scan" },
  access_blocked: { backoffSeconds: 6 * HOUR, recoveryAction: "review_access_route" },
  rate_limited: { backoffSeconds: 2 * HOUR, recoveryAction: "respect_retry_window" },
  timeout: { backoffSeconds: 30 * MINUTE, recoveryAction: "retry_isolated" },
  catalogue_empty: { backoffSeconds: HOUR, recoveryAction: "validate_catalogue_scope" },
  partial_catalogue: { backoffSeconds: 30 * MINUTE, recoveryAction: "repair_catalogue_discovery" },
  parser_regression: { backoffSeconds: HOUR, recoveryAction: "inspect_adapter_contract" },
  stock_selector_changed: { backoffSeconds: HOUR, recoveryAction: "repair_stock_selector" },
  identity_resolution: { backoffSeconds: HOUR, recoveryAction: "quarantine_identity_conflict" },
  market_conflict: { backoffSeconds: HOUR, recoveryAction: "quarantine_market_conflict" },
  stale_observation: { backoffSeconds: 15 * MINUTE, recoveryAction: "refresh_stale_observation" },
  network: { backoffSeconds: 15 * MINUTE, recoveryAction: "retry_network_path" },
  configuration: { backoffSeconds: 6 * HOUR, recoveryAction: "repair_configuration" },
  unknown: { backoffSeconds: 15 * MINUTE, recoveryAction: "inspect_failure" },
});

function normalizedFailure({ failureCode = null, lastError = null } = {}) {
  const code = String(failureCode || "").trim().toLowerCase();
  const detail = String(lastError || "").trim().toLowerCase();
  return { code, detail, combined: `${code} ${detail}`.trim() };
}

export function classifyRetailerFailure(input = {}) {
  const { code, detail, combined } = normalizedFailure(input);
  let failureClass = "unknown";

  if (input?.stale === true && !combined) failureClass = "stale_observation";
  else if (!combined) failureClass = "none";
  else if (/retailer_access_blocked|\b403\b|\b401\b|forbidden|access[_ -]?blocked|blocked .*request/.test(combined)) failureClass = "access_blocked";
  else if (/retailer_rate_limited|\b429\b|rate.?limit|too many requests/.test(combined)) failureClass = "rate_limited";
  else if (/retailer_scan_deadline|retailer_request_timeout|\bdeadline\b|timed out|timeout/.test(combined)) failureClass = "timeout";
  else if (/catalogue request failed \(404\)|structured catalogue request failed \(404\)|\bcatalogue\b.*\b404\b/.test(combined)) failureClass = "configuration";
  else if (/partial_catalogue_discovery|partial catalogue|verified product probes were processed/.test(combined)) failureClass = "partial_catalogue";
  else if (/zero_qualifying_products|qualification_no_products|zero qualifying products|zero qualifying catalogue/.test(combined)) failureClass = "catalogue_empty";
  else if (/stock[_ -]selector|availability selector|stock element|stock markup/.test(combined)) failureClass = "stock_selector_changed";
  else if (/identity[_ -](?:resolution|conflict)|canonical[_ -]identity|product identity (?:unknown|unresolved|conflict)/.test(combined)) failureClass = "identity_resolution";
  else if (/market[_ -]conflict|conflicting market|market resolution conflict/.test(combined)) failureClass = "market_conflict";
  else if (/safety cap|above safety cap|parser|selector|markup|schema changed|invalid (?:html|json)/.test(combined)) failureClass = "parser_regression";
  else if (/tcg_catalogue_ingestion_disabled|tcg_retailer_monitoring_disabled|external_collector|configuration|missing .*url|invalid .*url/.test(combined)) failureClass = "configuration";
  else if (/retailer_host_cooldown/.test(code)) {
    if (/access|403|401|blocked/.test(detail)) failureClass = "access_blocked";
    else if (/rate|429/.test(detail)) failureClass = "rate_limited";
    else failureClass = "network";
  } else if (/\b5\d\d\b|econn|enotfound|network|socket|fetch failed|connection/.test(combined)) failureClass = "network";

  const policy = FAILURE_POLICY[failureClass] || FAILURE_POLICY.unknown;
  return {
    failureClass,
    failureCode: code || null,
    backoffSeconds: policy.backoffSeconds,
    recoveryAction: policy.recoveryAction,
  };
}
