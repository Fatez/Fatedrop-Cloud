import { classifyProductAlert } from "../core/product-alert-intelligence.mjs";
import { classifyRetailerFailure } from "../core/retailer-failure-classification.mjs";

const LIFECYCLE_STATES = ["whisper", "echo", "manifested", "vanished"];
const VERIFIED_PURCHASE_EVIDENCE = new Set([
  "add_to_cart_verified",
  "checkout_verified",
  "availability_verified",
  "verified_stock_api",
  "purchase_path_verified",
]);

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function json(value, fallback) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function evidenceArray(value) {
  const parsed = json(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function increment(target, key, amount = 1) {
  const normalized = String(key || "unknown");
  target[normalized] = numeric(target[normalized]) + numeric(amount || 1);
}

function lifecycleCounts() {
  return Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, 0]));
}

function emptyRetailer(retailerId) {
  return {
    retailerId,
    retailerName: retailerId,
    configured: false,
    scanner: null,
    expectedScanIntervalSeconds: null,
    scans: {
      attempted: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      pagesScanned: 0,
      offersObserved: 0,
      skipReasons: {},
      failureReasons: {},
    },
    discovery: {
      rawProductsSeen: null,
      normalizedProductsSeen: null,
      filteredOutProducts: null,
      productLinksSeen: null,
      unresolvedProductLinksSeen: null,
      directRecoveryAttempted: null,
      directRecoveryRecovered: null,
      directRecoveryTruncated: null,
      telemetryRuns: 0,
    },
    changes: {
      changedOffers: 0,
      changedOffersWithoutAcceptedSignal: 0,
      noSignalReasons: {},
      marketResolution: {},
      languageResolution: {},
    },
    candidates: {
      ...lifecycleCounts(),
      source: "accepted_plus_canonical_conflicts_lower_bound",
      echoReadinessEvents: 0,
    },
    accepted: lifecycleCounts(),
    canonicalSuppression: {
      conflicts: 0,
      conflictReasons: {},
      deduplicated: null,
    },
    delivery: {
      emittedAlerts: 0,
      suppressedAlerts: 0,
      retryable: 0,
      outcomeUnknown: 0,
      deadLetter: 0,
      pending: 0,
      claimed: 0,
      suppressionReasons: {},
      stateCounts: {},
    },
    health: {
      healthy: null,
      lastScanAt: null,
      lastSuccessAt: null,
      lastError: null,
      failureCode: null,
      baselineCompleted: null,
      scanFreshness: "unknown",
      scanAgeSeconds: null,
      recoveryAction: null,
      failureClass: null,
    },
  };
}

function discoveryDiagnosticsFromRun(run) {
  const diagnostics = json(run?.diagnostics, {});
  const discovery = diagnostics?.discovery || diagnostics?.catalogue || null;
  if (!discovery || typeof discovery !== "object") return null;
  return discovery;
}

function addNullable(target, key, value) {
  if (!Number.isFinite(Number(value))) return;
  if (target[key] == null) target[key] = 0;
  target[key] += Number(value);
}

function marketStatus(evidence) {
  const entry = evidence.find((item) => item?.kind === "canonical_market_resolution");
  return String(entry?.status || "unknown").toLowerCase();
}

function languageStatus(evidence) {
  const entries = evidence.filter((item) => item?.kind === "alert_facet_language" || item?.kind === "canonical_language_resolution");
  const entry = entries.at(-1);
  return String(entry?.status || entry?.value || "unknown").toLowerCase();
}

function noSignalReason(row) {
  const productAlert = classifyProductAlert({ title: row.title, productType: row.product_type });
  if (productAlert.category !== "SEALED_TCG") return `product_type:${productAlert.category.toLowerCase()}`;

  const evidence = evidenceArray(row.evidence);
  const kinds = new Set(evidence.map((entry) => String(entry?.kind || "")).filter(Boolean));
  const purchaseVerified = [...VERIFIED_PURCHASE_EVIDENCE].some((kind) => kinds.has(kind));
  const status = String(row.stock_status || "").toLowerCase();
  if (status === "preorder" && !purchaseVerified) return "preorder_purchase_unverified";
  if (["in_stock", "low_stock", "preorder"].includes(status) && kinds.has("purchase_verification_required") && !purchaseVerified) {
    return "purchase_verification_required";
  }
  return "no_lifecycle_transition_or_candidate_not_persisted";
}

function scannerKind(retailer) {
  const adapter = String(retailer?.adapterType || "");
  if (adapter === "browser_collector") return "external_collector";
  if (["shopify", "woocommerce"].includes(adapter)) return "structured";
  if (retailer?.catalogue?.sitemapUrl && !(Array.isArray(retailer?.catalogueUrls) && retailer.catalogueUrls.length)) return "sitemap";
  return "catalogue";
}

export function buildSignalYieldReport({
  runRows = [],
  observationRows = [],
  signalRows = [],
  conflictRows = [],
  outboxRows = [],
  readinessRows = [],
  healthRows = [],
  configuredRetailers = [],
  since,
  now = Math.floor(Date.now() / 1000),
  globalIntervalSeconds = 300,
} = {}) {
  const retailers = new Map();
  const get = (retailerId) => {
    const id = String(retailerId || "unknown");
    if (!retailers.has(id)) retailers.set(id, emptyRetailer(id));
    return retailers.get(id);
  };

  for (const retailer of configuredRetailers || []) {
    const row = get(retailer.id);
    row.configured = true;
    row.retailerName = retailer.name || row.retailerName;
    row.scanner = scannerKind(retailer);
    const requested = Number(retailer.scanIntervalSeconds);
    row.expectedScanIntervalSeconds = Number.isFinite(requested)
      ? Math.max(globalIntervalSeconds, Math.round(requested))
      : globalIntervalSeconds;
  }

  for (const run of runRows || []) {
    const row = get(run.retailer_id);
    const status = String(run.status || "unknown").toLowerCase();
    row.scans.pagesScanned += numeric(run.pages_scanned);
    row.scans.offersObserved += numeric(run.products_observed);
    if (status === "skipped") {
      row.scans.skipped += 1;
      increment(row.scans.skipReasons, run.failure_code || "unspecified");
    } else {
      row.scans.attempted += 1;
      if (status === "success") row.scans.succeeded += 1;
      else if (status === "partial") row.scans.partial += 1;
      else if (status === "failed") row.scans.failed += 1;
      if (run.failure_code) increment(row.scans.failureReasons, run.failure_code);
    }

    const discovery = discoveryDiagnosticsFromRun(run);
    if (discovery) {
      row.discovery.telemetryRuns += 1;
      addNullable(row.discovery, "rawProductsSeen", discovery.rawProductsSeen ?? discovery.catalogueRawProductsSeen);
      addNullable(row.discovery, "normalizedProductsSeen", discovery.normalizedProductsSeen ?? discovery.catalogueRawProductsSeen);
      addNullable(row.discovery, "filteredOutProducts", discovery.filteredOutProducts ?? discovery.catalogueFilteredOutProducts);
      addNullable(row.discovery, "productLinksSeen", discovery.productLinksSeen);
      addNullable(row.discovery, "unresolvedProductLinksSeen", discovery.unresolvedProductLinksSeen);
      addNullable(row.discovery, "directRecoveryAttempted", discovery.directRecoveryAttempted);
      addNullable(row.discovery, "directRecoveryRecovered", discovery.directRecoveryProductsSeen ?? discovery.directFallbackProductsSeen);
      addNullable(row.discovery, "directRecoveryTruncated", discovery.directRecoveryTruncated);
    }
  }

  const acceptedKeys = new Set();
  for (const signal of signalRows || []) {
    const row = get(signal.retailer_id);
    if (signal.retailer_name) row.retailerName = signal.retailer_name;
    const state = String(signal.state || "").toLowerCase();
    if (LIFECYCLE_STATES.includes(state)) {
      row.accepted[state] += 1;
      row.candidates[state] += 1;
    }
    acceptedKeys.add(`${signal.offer_id || ""}:${signal.detected_at || ""}`);
  }

  for (const conflict of conflictRows || []) {
    const row = get(conflict.retailer_id);
    const stage = String(conflict.stage || "").toLowerCase();
    if (LIFECYCLE_STATES.includes(stage)) row.candidates[stage] += numeric(conflict.count || 1);
    row.canonicalSuppression.conflicts += numeric(conflict.count || 1);
    increment(row.canonicalSuppression.conflictReasons, conflict.reason || "unknown", conflict.count || 1);
  }

  for (const observation of observationRows || []) {
    const row = get(observation.retailer_id);
    row.changes.changedOffers += 1;
    const evidence = evidenceArray(observation.evidence);
    increment(row.changes.marketResolution, marketStatus(evidence));
    increment(row.changes.languageResolution, languageStatus(evidence));
    const key = `${observation.offer_id || ""}:${observation.observed_at || ""}`;
    if (!acceptedKeys.has(key)) {
      row.changes.changedOffersWithoutAcceptedSignal += 1;
      increment(row.changes.noSignalReasons, noSignalReason(observation));
    }
  }

  for (const readiness of readinessRows || []) {
    const row = get(readiness.retailer_id);
    const count = numeric(readiness.count || 1);
    row.candidates.echoReadinessEvents += count;
  }

  for (const outbox of outboxRows || []) {
    const row = get(outbox.retailer_id);
    const state = String(outbox.outbox_state || "unknown").toLowerCase();
    const count = numeric(outbox.count || 1);
    increment(row.delivery.stateCounts, state, count);
    if (state === "provider_accepted") row.delivery.emittedAlerts += count;
    else if (state === "suppressed") {
      row.delivery.suppressedAlerts += count;
      increment(row.delivery.suppressionReasons, outbox.last_error || `policy_${outbox.delivery_policy || "unknown"}`, count);
    } else if (state === "retryable") row.delivery.retryable += count;
    else if (state === "outcome_unknown") row.delivery.outcomeUnknown += count;
    else if (state === "dead_letter") row.delivery.deadLetter += count;
    else if (state === "pending") row.delivery.pending += count;
    else if (state === "claimed") row.delivery.claimed += count;
  }

  for (const health of healthRows || []) {
    const row = get(health.id || health.retailer_id);
    if (health.name || health.retailer_name) row.retailerName = health.name || health.retailer_name;
    const lastScanAt = Number(health.lastScanAt ?? health.last_scan_at) || null;
    const lastSuccessAt = Number(health.lastSuccessAt ?? health.last_success_at) || null;
    const expected = row.expectedScanIntervalSeconds || globalIntervalSeconds;
    const age = lastScanAt == null ? null : Math.max(0, now - lastScanAt);
    const failure = classifyRetailerFailure({
      failureCode: health.failureCode ?? health.failure_code,
      lastError: health.lastError ?? health.last_error,
      stale: age != null && age > Math.max(expected * 3, 20 * 60),
    });
    row.health = {
      healthy: health.healthy === true,
      lastScanAt,
      lastSuccessAt,
      lastError: health.lastError ?? health.last_error ?? null,
      failureCode: health.failureCode ?? health.failure_code ?? null,
      baselineCompleted: health.baselineCompleted ?? health.baseline_completed ?? null,
      scanFreshness: lastScanAt == null ? "never_scanned" : age > Math.max(expected * 3, 20 * 60) ? "stale" : age > expected * 1.5 ? "slow" : "fresh",
      scanAgeSeconds: age,
      recoveryAction: failure.recoveryAction,
      failureClass: failure.failureClass,
    };
  }

  const rows = [...retailers.values()].sort((left, right) => left.retailerName.localeCompare(right.retailerName));
  const totals = rows.reduce((sum, row) => {
    sum.scans += row.scans.attempted;
    sum.offersObserved += row.scans.offersObserved;
    sum.changedOffers += row.changes.changedOffers;
    sum.whisperCandidates += row.candidates.whisper;
    sum.echoCandidates += row.candidates.echoReadinessEvents || row.candidates.echo;
    sum.manifestedCandidates += row.candidates.manifested;
    sum.emittedAlerts += row.delivery.emittedAlerts;
    sum.suppressedAlerts += row.delivery.suppressedAlerts;
    return sum;
  }, { scans: 0, offersObserved: 0, changedOffers: 0, whisperCandidates: 0, echoCandidates: 0, manifestedCandidates: 0, emittedAlerts: 0, suppressedAlerts: 0 });

  const gaps = [];
  if (rows.some((row) => row.discovery.telemetryRuns === 0)) gaps.push("pre_observation_filter_counts_missing_for_runs_without_discovery_diagnostics");
  gaps.push("canonical_deduplication_counts_are_not_persisted_historically");
  gaps.push("candidate_counts_are_a_lower_bound_before_candidate_stage_run_telemetry_is_persisted");

  return {
    available: true,
    generatedAt: now,
    since: Number(since) || null,
    totals,
    retailers: rows,
    telemetryGaps: gaps,
    semantics: {
      whisper: "early product evidence only; never confirmed stock",
      echo: "retailer readiness behaviour only; never confirmed stock",
      manifested: "confirmed canonical purchasable availability only",
      vanished: "previously confirmed availability no longer verified",
    },
  };
}

export async function loadSignalYieldReport(store, {
  hours = 24,
  now = Math.floor(Date.now() / 1000),
  configuredRetailers = [],
  globalIntervalSeconds = 300,
} = {}) {
  if (!store || typeof store.pool !== "function") return { available: false, reason: "persistent_store_unavailable", generatedAt: now };
  const safeHours = Math.max(1, Math.min(24 * 30, Math.trunc(Number(hours) || 24)));
  const since = Math.max(0, now - (safeHours * 60 * 60));
  const pool = await store.pool();

  const [runs, observations, signals, conflicts, outbox, readiness, healthRows] = await Promise.all([
    pool.query(`SELECT retailer_id,status,pages_scanned,products_observed,failure_code,diagnostics,started_at,completed_at
      FROM fatedrop_retailer_monitor_runs
      WHERE started_at >= $1 OR completed_at >= $1
      ORDER BY started_at ASC`, [since]),
    pool.query(`SELECT observation.retailer_id,observation.offer_id,observation.observed_at,observation.stock_status,
        observation.stock_confidence,observation.stock_quantity,observation.price_pence,observation.evidence,
        offer.title,product.product_type
      FROM fatedrop_stock_observations observation
      JOIN fatedrop_retail_offers offer ON offer.offer_id=observation.offer_id
      JOIN fatedrop_products product ON product.id=offer.product_id
      WHERE observation.observed_at >= $1
      ORDER BY observation.observed_at ASC`, [since]),
    pool.query(`SELECT id,state,retailer_id,retailer_name,offer_id,detected_at
      FROM fatedrop_signals
      WHERE detected_at >= $1 AND state IN ('whisper','echo','manifested','vanished')
      ORDER BY detected_at ASC`, [since]),
    pool.query(`SELECT retailer_id,stage,reason,COUNT(*)::int AS count
      FROM fatedrop_stock_episode_conflicts
      WHERE occurred_at >= $1
      GROUP BY retailer_id,stage,reason`, [since]),
    pool.query(`SELECT signal.retailer_id,outbox.state AS outbox_state,outbox.delivery_policy,COALESCE(outbox.last_error,'') AS last_error,COUNT(*)::int AS count
      FROM fatedrop_signal_delivery_outbox outbox
      JOIN fatedrop_signals signal ON signal.id=outbox.signal_id
      WHERE outbox.created_at >= $1
      GROUP BY signal.retailer_id,outbox.state,outbox.delivery_policy,outbox.last_error`, [since]),
    pool.query(`SELECT evidence_json->'retailer'->>'id' AS retailer_id,COUNT(*)::int AS count
      FROM fatedrop_signal_events
      WHERE kind='retailer_readiness' AND occurred_at >= $1
        AND COALESCE(evidence_json->'retailer'->>'id','') <> ''
      GROUP BY evidence_json->'retailer'->>'id'`, [since]),
    store.listRetailers(),
  ]);

  return buildSignalYieldReport({
    runRows: runs.rows,
    observationRows: observations.rows,
    signalRows: signals.rows,
    conflictRows: conflicts.rows,
    outboxRows: outbox.rows,
    readinessRows: readiness.rows,
    healthRows,
    configuredRetailers,
    since,
    now,
    globalIntervalSeconds,
  });
}
