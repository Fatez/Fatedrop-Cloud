import crypto from "node:crypto";

import { env } from "../config/env.mjs";
import { deriveAlertFacets } from "../core/alert-facets.mjs";
import { canEmitTcgLifecycleAlerts, requireKnownTcg } from "../trader/tcg-registry.mjs";
import { operatorLocalRadarBridgeConfig, probeOperatorLocalRadarBridge } from "./operator-local-radar-bridge-health.mjs";
import {
  inspectCuratedIncomingIntelTargets,
  reconcileCuratedIncomingIntel,
} from "./curated-incoming-intel-reconcile.mjs";

const OPERATOR_REPOSITORY = "Fatez/Fatedrop-Cloud";
const OPERATOR_LOGIN = "Fatez";
const ISSUE_PREFIX = "[FATEDROP LOCAL RADAR]";
const ECHO_ISSUE_PREFIX = "[FATEDROP ECHO]";
const TEST_ISSUE_TITLE = "[FATEDROP LOCAL RADAR] TEST ONLY";
const POLL_INTERVAL_MS = 120_000;
const POLL_START_DELAY_MS = 20_000;
const GITHUB_ISSUES_URL = `https://api.github.com/repos/${OPERATOR_REPOSITORY}/issues?state=open&per_page=100&sort=created&direction=desc`;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_RETRYABLE_ATTEMPTS = 2;
const STRONG_ECHO_SOURCES = new Set([
  "official_retailer_page",
  "official_store_social",
  "retailer_staff_report",
  "retailer_submission",
  "authorised_feed",
  "operator_manual",
]);
const OFFICIAL_PREPARATION_SOURCES = new Set(["official_retailer_page", "authorised_feed"]);

function text(value, max = 500) {
  const result = typeof value === "string" ? value.trim().slice(0, max) : "";
  return result || null;
}

function stringList(value, maxItems = 100, maxLength = 180) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    const clean = text(item, maxLength);
    if (clean) unique.add(clean);
    if (unique.size >= maxItems) break;
  }
  return [...unique];
}

function iso(value, label) {
  const clean = text(value, 80);
  if (!clean) return null;
  const parsed = Date.parse(clean);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date/time`);
  return new Date(parsed).toISOString();
}

function confidence(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function optionalHttpsUrl(value) {
  const clean = text(value, 700);
  if (!clean) return null;
  let parsed;
  try { parsed = new URL(clean); } catch { throw new Error("sourceUrl must be a valid public HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname || parsed.hostname === "localhost") {
    throw new Error("sourceUrl must be a valid public HTTPS URL");
  }
  return parsed.toString();
}

function issueFingerprint(issue) {
  return crypto.createHash("sha256")
    .update(`${issue?.number || ""}|${issue?.updated_at || ""}|${issue?.body || ""}`)
    .digest("hex");
}

export function operatorGithubConfig() {
  const token = text(process.env.FATEDROP_GITHUB_OPERATOR_TOKEN, 1000);
  return {
    token,
    authenticated: Boolean(token),
    required: String(process.env.RAILWAY_ENVIRONMENT_NAME || "").trim().toLowerCase() === "production",
  };
}

function githubRequestHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "FateDrop-Local-Radar-Operator/1.0",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function githubHttpError(response) {
  const remaining = response?.headers?.get?.("x-ratelimit-remaining");
  const code = (response?.status === 429 || (response?.status === 403 && remaining === "0"))
    ? "github_rate_limited"
    : `github_http_${Number(response?.status) || 0}`;
  const error = new Error(code);
  error.code = code;
  error.status = Number(response?.status) || null;
  return error;
}

function operatorPollErrorCode(error) {
  const explicit = text(error?.code, 80);
  if (explicit && /^(github_(?:auth_missing|rate_limited|request_failed|timeout|invalid_payload)|github_http_[1-5][0-9]{2})$/.test(explicit)) {
    return explicit;
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "github_timeout";
  return "github_request_failed";
}

function retryableGithubFailure(error) {
  return error?.code === "github_rate_limited"
    || error?.code === "github_timeout"
    || error?.code === "github_request_failed"
    || /^github_http_5[0-9]{2}$/.test(String(error?.code || ""));
}

export function parseOperatorIssue(issue, now = Date.now()) {
  if (!issue || typeof issue !== "object") throw new Error("Operator issue is missing");
  if (issue.pull_request) throw new Error("Pull requests are not operator alerts");
  if (issue.state !== "open") throw new Error("Operator issue must be open");
  if (issue.user?.login !== OPERATOR_LOGIN) throw new Error("Operator issue author is not authorised");
  if (![ISSUE_PREFIX, ECHO_ISSUE_PREFIX].some((prefix) => String(issue.title || "").startsWith(prefix))) throw new Error("Operator issue prefix is invalid");

  let payload;
  try {
    payload = JSON.parse(String(issue.body || ""));
  } catch {
    throw new Error("Operator issue body must be raw JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Operator payload must be an object");
  if (Number(payload.schemaVersion) !== 1) throw new Error("Operator payload schemaVersion must be 1");

  const testOnly = payload.testOnly === true;
  if (testOnly && String(issue.title || "").trim() !== TEST_ISSUE_TITLE) {
    throw new Error("testOnly operator issues must use the exact TEST ONLY title");
  }
  if (!testOnly && String(issue.title || "").trim() === TEST_ISSUE_TITLE) {
    throw new Error("TEST ONLY operator issues must set testOnly=true");
  }

  const retailerId = text(payload.retailerId, 120);
  const retailerName = text(payload.retailerName, 120);
  const rawProductTitle = text(payload.rawProductTitle, 220);
  const tcgCode = requireKnownTcg(text(payload.tcgCode, 80) || "pokemon").code;
  const targetBranches = stringList(payload.targetBranches, 500, 180);
  const availabilityScope = payload.availabilityScope === "online_retailer_readiness"
    ? "online_retailer_readiness"
    : "physical_branch";
  const sourceType = text(payload.sourceType, 80)?.toLowerCase() || "operator_manual";
  const sourceUrl = optionalHttpsUrl(payload.sourceUrl);
  const sourceLabel = text(payload.sourceLabel, 180) || "FateDrop operator intelligence";
  const explicitTcgRelevance = payload.explicitTcgRelevance === true;
  const expectedFrom = iso(payload.expectedFrom, "expectedFrom");
  const expectedTo = iso(payload.expectedTo, "expectedTo");
  const expiresAt = iso(payload.expiresAt, "expiresAt");
  const expectedLabel = text(payload.expectedLabel, 120);
  const notificationDateLabel = text(payload.notificationDateLabel, 120)
    || expectedLabel?.replace(/^expected\s+/i, "")
    || (expectedFrom ? new Date(expectedFrom).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" }) : null);

  if (!retailerId || !retailerName) throw new Error("retailerId and retailerName are required");
  if (!rawProductTitle) throw new Error("rawProductTitle is required");
  if (!canEmitTcgLifecycleAlerts(tcgCode)) throw new Error(`Public lifecycle alerts are disabled for TCG: ${tcgCode}`);
  if (availabilityScope === "physical_branch" && !targetBranches.length) throw new Error("At least one named target branch is required before a Local Radar broadcast");
  if (availabilityScope === "online_retailer_readiness" && !sourceUrl && !text(payload.evidenceBasis, 700)) throw new Error("Online readiness Echo requires a source URL or evidence basis");
  if (!expectedFrom && !expectedTo && !expectedLabel) throw new Error("An expected date/window is required");
  if (!expiresAt || Date.parse(expiresAt) <= now) throw new Error("expiresAt must be in the future");
  if (expectedFrom && expectedTo && Date.parse(expectedTo) < Date.parse(expectedFrom)) throw new Error("expectedTo cannot be before expectedFrom");

  const requestedKind = text(payload.kind, 20)?.toLowerCase();
  const kind = requestedKind === "echo" && STRONG_ECHO_SOURCES.has(sourceType) ? "echo" : "whisper";
  if (availabilityScope === "online_retailer_readiness" && kind !== "echo") throw new Error("Online readiness requires an explicit authorised Echo request");
  const defaultConfidence = kind === "echo" ? 0.68 : 0.48;
  const maxConfidence = kind === "echo" ? 0.8 : 0.59;
  const safeConfidence = Math.min(maxConfidence, confidence(payload.confidence, defaultConfidence));
  const requestedPhysicalState = text(payload.physicalEvidenceState, 24)?.toLowerCase();
  if (requestedPhysicalState && !["expected", "reported"].includes(requestedPhysicalState)) {
    throw new Error("Manual physical Echo may only be expected or reported");
  }
  if (requestedPhysicalState === "expected" && !OFFICIAL_PREPARATION_SOURCES.has(sourceType)) {
    throw new Error("Echo · Expected requires an official preparation source");
  }
  const physicalEvidenceState = availabilityScope === "physical_branch"
    ? requestedPhysicalState || (OFFICIAL_PREPARATION_SOURCES.has(sourceType) ? "expected" : "reported")
    : null;
  const issueNumber = Number(issue.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("Operator issue number is invalid");

  return {
    issueNumber,
    testOnly,
    eventId: testOnly ? `local-radar-operator-test:${issueNumber}` : `local-radar-operator:${issueNumber}`,
    availabilityScope,
    physicalEvidenceState,
    retailerName,
    notificationDateLabel,
    entry: {
      id: testOnly ? `operator-local-radar-test-${issueNumber}` : `operator-local-radar-${issueNumber}`,
      retailerId,
      tcgCode,
      kind,
      availabilityScope,
      physicalEvidenceState,
      rawProductTitle,
      sourceType,
      sourceId: `github:${OPERATOR_REPOSITORY}:issue:${issueNumber}`,
      sourceUrl,
      sourceLabel,
      explicitTcgRelevance,
      observedAt: iso(issue.created_at, "issue created_at") || new Date(now).toISOString(),
      expectedFrom,
      expectedTo,
      expectedLabel,
      expiresAt,
      confidence: safeConfidence,
      evidenceBasis: text(payload.evidenceBasis, 700) || "Human-curated FateDrop operator intelligence. Availability is expected only and is not guaranteed.",
      note: text(payload.note, 300) || "Incoming stock intelligence only. Check the retailer before travelling.",
      targetBranches,
    },
  };
}

export function buildOperatorNotification(parsed, reconciliation) {
  const branchCount = parsed.entry.targetBranches.length;
  if (parsed.availabilityScope === "physical_branch" && (reconciliation.unmatchedTargets?.length || reconciliation.matchedBranches !== branchCount)) {
    return null;
  }
  const datePhrase = parsed.notificationDateLabel ? ` ${parsed.notificationDateLabel}` : "";
  const storeWord = branchCount === 1 ? "store" : "stores";
  const facets = deriveAlertFacets({ title: parsed.entry.rawProductTitle, retailerCountryCode: "GB" });
  const facetPayload = { languageGroup: facets.languageGroup, setKey: facets.setKey };
  if (parsed.testOnly) {
    return {
      eventId: parsed.eventId,
      testOnly: true,
      stage: parsed.entry.kind === "echo" ? "ECHO" : "WHISPER",
      route: parsed.availabilityScope === "physical_branch" ? "local-radar" : "alerts",
      availabilityScope: parsed.availabilityScope,
      availabilityVerified: false,
      physicalEvidenceState: parsed.physicalEvidenceState,
      title: "FateDrop · Local Radar · TEST ONLY",
      body: `TEST ONLY · Operator transport verification matched ${branchCount} canonical ${parsed.retailerName} ${storeWord}. No stock or Local Radar history has been created.`,
      retailerId: parsed.entry.retailerId,
      tcgCode: parsed.entry.tcgCode,
      retailerName: parsed.retailerName,
      productTitle: parsed.entry.rawProductTitle,
      expectedFrom: parsed.entry.expectedFrom,
      expectedTo: parsed.entry.expectedTo,
      expectedLabel: parsed.entry.expectedLabel,
      branchCount,
      operatorIssue: parsed.issueNumber,
      ...facetPayload,
    };
  }
  if (parsed.availabilityScope === "online_retailer_readiness") {
    return {
      eventId: parsed.eventId,
      testOnly: false,
      stage: "ECHO",
      route: "alerts",
      presentationType: "readiness_echo",
      title: "FateDrop · Echo · Be ready",
      body: `${parsed.entry.rawProductTitle} · ${parsed.entry.expectedLabel || "credible retailer movement observed"}. This is readiness evidence, not confirmed stock.`,
      retailerId: parsed.entry.retailerId,
      tcgCode: parsed.entry.tcgCode,
      retailerName: parsed.retailerName,
      productTitle: parsed.entry.rawProductTitle,
      expectedFrom: parsed.entry.expectedFrom,
      expectedTo: parsed.entry.expectedTo,
      expectedLabel: parsed.entry.expectedLabel,
      sourceUrl: parsed.entry.sourceUrl,
      evidenceObservedAt: parsed.entry.observedAt,
      availabilityScope: parsed.availabilityScope,
      availabilityVerified: false,
      operatorIssue: parsed.issueNumber,
      ...facetPayload,
    };
  }
  return {
    eventId: parsed.eventId,
    testOnly: false,
    stage: parsed.entry.kind === "echo" ? "ECHO" : "WHISPER",
    route: "local-radar",
    presentationType: "big_fate_signal",
    physicalEvidenceState: parsed.physicalEvidenceState,
    availabilityScope: parsed.availabilityScope,
    availabilityVerified: false,
    radiusTargeted: false,
    deliveryPolicy: "radius_targeted_only",
    title: "FateDrop · Big Fate Signal · Echo",
    body: `${parsed.entry.rawProductTitle} has ${parsed.physicalEvidenceState === "reported" ? "reported movement" : "expected allocation"} at ${branchCount} ${parsed.retailerName} ${storeWord}${datePhrase}. Physical availability is not confirmed.`,
    retailerId: parsed.entry.retailerId,
    tcgCode: parsed.entry.tcgCode,
    retailerName: parsed.retailerName,
    productTitle: parsed.entry.rawProductTitle,
    expectedFrom: parsed.entry.expectedFrom,
    expectedTo: parsed.entry.expectedTo,
    expectedLabel: parsed.entry.expectedLabel,
    retailerUrl: parsed.entry.sourceUrl,
    ctaLabel: `CHECK ${parsed.retailerName.toUpperCase()}`,
    evidenceObservedAt: parsed.entry.observedAt,
    branchCount,
    operatorIssue: parsed.issueNumber,
    ...facetPayload,
  };
}

function operatorReadinessEvent(parsed) {
  const occurredAt = Math.floor(Date.parse(parsed.entry.observedAt) / 1000);
  return {
    id: parsed.eventId,
    kind: "operator_retailer_readiness",
    occurredAt,
    evidence: {
      schemaVersion: 1,
      stage: "echo",
      signalKind: "operator_readiness",
      availabilityScope: "online_retailer_readiness",
      availabilityVerified: false,
      operatorIssue: parsed.issueNumber,
      tcgCode: parsed.entry.tcgCode,
      retailerId: parsed.entry.retailerId,
      retailerName: parsed.retailerName,
      productTitle: parsed.entry.rawProductTitle,
      sourceType: parsed.entry.sourceType,
      sourceUrl: parsed.entry.sourceUrl,
      sourceLabel: parsed.entry.sourceLabel,
      evidenceObservedAt: parsed.entry.observedAt,
      expectedFrom: parsed.entry.expectedFrom,
      expectedTo: parsed.entry.expectedTo,
      expectedLabel: parsed.entry.expectedLabel,
      expiresAt: parsed.entry.expiresAt,
      confidence: parsed.entry.confidence,
      evidenceBasis: parsed.entry.evidenceBasis,
      note: parsed.entry.note,
    },
  };
}

async function persistOperatorReadinessEvent(store, parsed) {
  if (!store) throw new Error("Online readiness Echo requires the canonical store");
  const event = operatorReadinessEvent(parsed);
  if (typeof store.appendSignalEvent === "function") {
    await store.appendSignalEvent(event);
    return { persisted: true, event };
  }
  if (typeof store.pool !== "function") throw new Error("Online readiness Echo persistence is unavailable");
  const pool = await store.pool();
  const result = await pool.query(
    `INSERT INTO fatedrop_signal_events
      (id,kind,product_identity_id,offer_id,retailer_id,location_id,occurred_at,evidence_json)
     VALUES ($1,$2,NULL,NULL,NULL,NULL,$3,$4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.kind, event.occurredAt, JSON.stringify(event.evidence)],
  );
  return { persisted: true, inserted: result.rowCount === 1, event };
}

export async function publishOperatorNotification(notification, fetchImpl = fetch) {
  const { snapshotUrl, secret, configured } = operatorLocalRadarBridgeConfig();
  if (!configured) return { published: false, reason: "web_bridge_not_configured" };
  let target;
  try {
    target = new URL("/api/dashboard/local-radar-operator-alert", snapshotUrl).toString();
  } catch {
    return { published: false, reason: "web_bridge_url_invalid" };
  }
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { published: false, reason: "web_bridge_rejected", status: response.status, result };
    return { published: true, status: response.status, result };
  } catch (error) {
    return { published: false, reason: "web_bridge_failed", error: String(error?.message || error) };
  }
}

export async function processOperatorIssue({ issue, store, fetchImpl = fetch, now = Date.now() }) {
  const parsed = parseOperatorIssue(issue, now);
  if (parsed.availabilityScope === "online_retailer_readiness") {
    const readinessEvent = await persistOperatorReadinessEvent(store, parsed);
    const notification = buildOperatorNotification(parsed, { matchedBranches: 0, unmatchedTargets: [] });
    const push = await publishOperatorNotification(notification, fetchImpl);
    return {
      status: push.published ? "published" : "retry",
      testOnly: parsed.testOnly,
      eventId: parsed.eventId,
      matchedBranches: 0,
      expectedBranches: 0,
      readinessEvent,
      push,
      truthRule: "Authorised manual retailer-readiness movement is Echo only. It does not write physical stock, create Manifested, or claim purchasable availability.",
    };
  }
  if (!store) throw new Error("Operator Local Radar intake requires the canonical store");
  const reconciliation = parsed.testOnly
    ? await inspectCuratedIncomingIntelTargets({ store, entries: [parsed.entry], now })
    : await reconcileCuratedIncomingIntel({ store, entries: [parsed.entry], now });
  const notification = buildOperatorNotification(parsed, reconciliation);
  if (!notification) {
    return {
      status: "held",
      testOnly: parsed.testOnly,
      eventId: parsed.eventId,
      matchedBranches: reconciliation.matchedBranches,
      expectedBranches: parsed.entry.targetBranches.length,
      unmatchedTargets: reconciliation.unmatchedTargets,
      truthRule: reconciliation.truthRule,
    };
  }
  if (!parsed.testOnly && notification.deliveryPolicy === "radius_targeted_only" && notification.radiusTargeted !== true) {
    return {
      status: "ingested",
      testOnly: false,
      eventId: parsed.eventId,
      matchedBranches: reconciliation.matchedBranches,
      expectedBranches: parsed.entry.targetBranches.length,
      push: { published: false, reason: "radius_targeting_required" },
      truthRule: `${reconciliation.truthRule} Physical interrupt delivery is held until recipient radius targeting is proven.`,
    };
  }
  const push = await publishOperatorNotification(notification, fetchImpl);
  return {
    status: push.published ? "published" : "retry",
    testOnly: parsed.testOnly,
    eventId: parsed.eventId,
    matchedBranches: reconciliation.matchedBranches,
    expectedBranches: parsed.entry.targetBranches.length,
    push,
    truthRule: reconciliation.truthRule,
  };
}

export async function listOperatorIssues(fetchImpl = fetch, config = operatorGithubConfig()) {
  if (config.required && !config.authenticated) {
    const error = new Error("github_auth_missing");
    error.code = "github_auth_missing";
    throw error;
  }
  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= GITHUB_RETRYABLE_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchImpl(GITHUB_ISSUES_URL, {
        headers: githubRequestHeaders(config.token),
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) break;
      throw githubHttpError(response);
    } catch (error) {
      const code = operatorPollErrorCode(error);
      lastError = Object.assign(new Error(code), { code });
      if (attempt >= GITHUB_RETRYABLE_ATTEMPTS || !retryableGithubFailure(lastError)) throw lastError;
    }
  }
  if (!response?.ok) throw lastError || Object.assign(new Error("github_request_failed"), { code: "github_request_failed" });
  const issues = await response.json().catch(() => null);
  if (!Array.isArray(issues)) {
    const error = new Error("github_invalid_payload");
    error.code = "github_invalid_payload";
    throw error;
  }
  return Array.isArray(issues)
    ? issues.filter((issue) => !issue?.pull_request && issue?.state === "open" && issue?.user?.login === OPERATOR_LOGIN && [ISSUE_PREFIX, ECHO_ISSUE_PREFIX].some((prefix) => String(issue?.title || "").startsWith(prefix)))
    : [];
}

const processedFingerprints = new Map();
let polling = false;
let watcherStarted = false;
const operatorHealth = {
  started: false,
  lastPollStartedAt: null,
  lastPollCompletedAt: null,
  lastStatus: "not_started",
  issuesSeen: 0,
  published: 0,
  held: 0,
  retry: 0,
  invalid: 0,
  lastErrorCode: null,
};

export function getOperatorLocalRadarHealth() {
  const bridgeConfig = operatorLocalRadarBridgeConfig();
  const githubConfig = operatorGithubConfig();
  return {
    ...operatorHealth,
    intervalSeconds: Math.floor(POLL_INTERVAL_MS / 1000),
    startDelaySeconds: Math.floor(POLL_START_DELAY_MS / 1000),
    canonicalStoreConfigured: Boolean(env.databaseUrl && env.store === "postgres"),
    webBridgeConfigured: bridgeConfig.configured,
    githubAuthenticated: githubConfig.authenticated,
  };
}

export async function pollOperatorIssues({ store, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!store) return { status: "disabled", reason: "store_required" };
  if (polling) return { status: "busy" };
  polling = true;
  operatorHealth.lastPollStartedAt = Math.floor(now / 1000);
  try {
    const bridge = process.env.RAILWAY_ENVIRONMENT_NAME === "production"
      ? await probeOperatorLocalRadarBridge()
      : { configured: true, reachable: true, status: "not_probed_outside_production" };
    const issues = await listOperatorIssues(fetchImpl);
    const results = [];
    for (const issue of issues) {
      const fingerprint = issueFingerprint(issue);
      if (processedFingerprints.get(issue.number) === fingerprint) continue;
      try {
        const result = await processOperatorIssue({ issue, store, fetchImpl, now });
        results.push({ issue: issue.number, ...result });
        if (["published", "ingested"].includes(result.status)) processedFingerprints.set(issue.number, fingerprint);
      } catch (error) {
        const reason = String(error?.message || error);
        results.push({ issue: issue.number, status: "invalid", reason });
        processedFingerprints.set(issue.number, fingerprint);
      }
    }
    operatorHealth.lastPollCompletedAt = Math.floor(now / 1000);
    operatorHealth.lastStatus = bridge.reachable ? "ok" : "bridge_unavailable";
    operatorHealth.issuesSeen = issues.length;
    operatorHealth.published = results.filter((result) => result.status === "published").length;
    operatorHealth.held = results.filter((result) => result.status === "held").length;
    operatorHealth.retry = results.filter((result) => result.status === "retry").length;
    operatorHealth.invalid = results.filter((result) => result.status === "invalid").length;
    operatorHealth.lastErrorCode = bridge.reachable ? null : `bridge_${bridge.status}`;
    if (results.length) console.log("[signal-engine] Local Radar operator intake", results);
    return { status: operatorHealth.lastStatus, issues: issues.length, results };
  } catch (error) {
    operatorHealth.lastPollCompletedAt = Math.floor(now / 1000);
    operatorHealth.lastStatus = "failed";
    operatorHealth.issuesSeen = 0;
    operatorHealth.published = 0;
    operatorHealth.held = 0;
    operatorHealth.retry = 0;
    operatorHealth.invalid = 0;
    operatorHealth.lastErrorCode = operatorPollErrorCode(error);
    console.error("[signal-engine] Local Radar operator intake failed", { errorCode: operatorHealth.lastErrorCode });
    return { status: "failed", errorCode: operatorHealth.lastErrorCode };
  } finally {
    polling = false;
  }
}

export function startOperatorLocalRadarIntake({ store, fetchImpl = fetch } = {}) {
  if (watcherStarted) return { started: false, reason: "already_started" };
  if (!env.databaseUrl || env.store !== "postgres") return { started: false, reason: "postgres_not_configured" };
  if (!store) return { started: false, reason: "store_required" };

  watcherStarted = true;
  operatorHealth.started = true;
  operatorHealth.lastStatus = "awaiting_first_poll";
  const timer = setTimeout(() => { void pollOperatorIssues({ store, fetchImpl }); }, POLL_START_DELAY_MS);
  timer.unref();
  const interval = setInterval(() => { void pollOperatorIssues({ store, fetchImpl }); }, POLL_INTERVAL_MS);
  interval.unref();
  return { started: true, intervalMs: POLL_INTERVAL_MS, startDelayMs: POLL_START_DELAY_MS };
}
