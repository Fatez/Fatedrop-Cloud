import crypto from "node:crypto";

import { env } from "../config/env.mjs";
import { reconcileCuratedIncomingIntel } from "./curated-incoming-intel-reconcile.mjs";

const OPERATOR_REPOSITORY = "Fatez/Fatedrop-Cloud";
const OPERATOR_LOGIN = "Fatez";
const ISSUE_PREFIX = "[FATEDROP LOCAL RADAR]";
const POLL_INTERVAL_MS = 120_000;
const POLL_START_DELAY_MS = 20_000;
const STRONG_ECHO_SOURCES = new Set([
  "official_retailer_page",
  "official_store_social",
  "retailer_staff_report",
  "retailer_submission",
  "authorised_feed",
]);

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

function issueFingerprint(issue) {
  return crypto.createHash("sha256")
    .update(`${issue?.number || ""}|${issue?.updated_at || ""}|${issue?.body || ""}`)
    .digest("hex");
}

export function parseOperatorIssue(issue, now = Date.now()) {
  if (!issue || typeof issue !== "object") throw new Error("Operator issue is missing");
  if (issue.pull_request) throw new Error("Pull requests are not operator alerts");
  if (issue.state !== "open") throw new Error("Operator issue must be open");
  if (issue.user?.login !== OPERATOR_LOGIN) throw new Error("Operator issue author is not authorised");
  if (!String(issue.title || "").startsWith(ISSUE_PREFIX)) throw new Error("Operator issue prefix is invalid");

  let payload;
  try {
    payload = JSON.parse(String(issue.body || ""));
  } catch {
    throw new Error("Operator issue body must be raw JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Operator payload must be an object");
  if (Number(payload.schemaVersion) !== 1) throw new Error("Operator payload schemaVersion must be 1");

  const retailerId = text(payload.retailerId, 120);
  const retailerName = text(payload.retailerName, 120);
  const rawProductTitle = text(payload.rawProductTitle, 220);
  const targetBranches = stringList(payload.targetBranches, 100, 180);
  const sourceType = text(payload.sourceType, 80)?.toLowerCase() || "operator_manual";
  const sourceUrl = text(payload.sourceUrl, 700);
  const sourceLabel = text(payload.sourceLabel, 180) || "FateDrop operator intelligence";
  const expectedFrom = iso(payload.expectedFrom, "expectedFrom");
  const expectedTo = iso(payload.expectedTo, "expectedTo");
  const expiresAt = iso(payload.expiresAt, "expiresAt");
  const expectedLabel = text(payload.expectedLabel, 120);
  const notificationDateLabel = text(payload.notificationDateLabel, 120)
    || expectedLabel?.replace(/^expected\s+/i, "")
    || (expectedFrom ? new Date(expectedFrom).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" }) : null);

  if (!retailerId || !retailerName) throw new Error("retailerId and retailerName are required");
  if (!rawProductTitle) throw new Error("rawProductTitle is required");
  if (!targetBranches.length) throw new Error("At least one named target branch is required before a Local Radar broadcast");
  if (!expectedFrom && !expectedTo && !expectedLabel) throw new Error("An expected date/window is required");
  if (!expiresAt || Date.parse(expiresAt) <= now) throw new Error("expiresAt must be in the future");
  if (expectedFrom && expectedTo && Date.parse(expectedTo) < Date.parse(expectedFrom)) throw new Error("expectedTo cannot be before expectedFrom");

  const requestedKind = text(payload.kind, 20)?.toLowerCase();
  const kind = requestedKind === "echo" && STRONG_ECHO_SOURCES.has(sourceType) ? "echo" : "whisper";
  const defaultConfidence = kind === "echo" ? 0.68 : 0.48;
  const maxConfidence = kind === "echo" ? 0.8 : 0.59;
  const safeConfidence = Math.min(maxConfidence, confidence(payload.confidence, defaultConfidence));
  const issueNumber = Number(issue.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("Operator issue number is invalid");

  return {
    issueNumber,
    eventId: `local-radar-operator:${issueNumber}`,
    retailerName,
    notificationDateLabel,
    entry: {
      id: `operator-local-radar-${issueNumber}`,
      retailerId,
      kind,
      rawProductTitle,
      sourceType,
      sourceId: `github:${OPERATOR_REPOSITORY}:issue:${issueNumber}`,
      sourceUrl,
      sourceLabel,
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
  if (reconciliation.unmatchedTargets?.length || reconciliation.matchedBranches !== branchCount) {
    return null;
  }
  const datePhrase = parsed.notificationDateLabel ? ` ${parsed.notificationDateLabel}` : "";
  const storeWord = branchCount === 1 ? "store" : "stores";
  return {
    eventId: parsed.eventId,
    stage: parsed.entry.kind === "echo" ? "ECHO" : "WHISPER",
    title: "FateDrop · Local Radar · Incoming stock",
    body: `${parsed.entry.rawProductTitle} expected at ${branchCount} ${parsed.retailerName} ${storeWord}${datePhrase}. Check Local Radar to see if a participating store is near you.`,
    retailerId: parsed.entry.retailerId,
    retailerName: parsed.retailerName,
    productTitle: parsed.entry.rawProductTitle,
    expectedFrom: parsed.entry.expectedFrom,
    expectedTo: parsed.entry.expectedTo,
    expectedLabel: parsed.entry.expectedLabel,
    branchCount,
    operatorIssue: parsed.issueNumber,
  };
}

export async function publishOperatorNotification(notification, fetchImpl = fetch) {
  const snapshotUrl = text(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL, 1000);
  const secret = text(process.env.FATEDROP_METRICS_INGEST_SECRET, 1000);
  if (!snapshotUrl || !secret) return { published: false, reason: "web_bridge_not_configured" };
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
  if (!store) throw new Error("Operator Local Radar intake requires the canonical store");
  const parsed = parseOperatorIssue(issue, now);
  const reconciliation = await reconcileCuratedIncomingIntel({ store, entries: [parsed.entry], now });
  const notification = buildOperatorNotification(parsed, reconciliation);
  if (!notification) {
    return {
      status: "held",
      eventId: parsed.eventId,
      matchedBranches: reconciliation.matchedBranches,
      expectedBranches: parsed.entry.targetBranches.length,
      unmatchedTargets: reconciliation.unmatchedTargets,
      truthRule: reconciliation.truthRule,
    };
  }
  const push = await publishOperatorNotification(notification, fetchImpl);
  return {
    status: push.published ? "published" : "retry",
    eventId: parsed.eventId,
    matchedBranches: reconciliation.matchedBranches,
    expectedBranches: parsed.entry.targetBranches.length,
    push,
    truthRule: reconciliation.truthRule,
  };
}

export async function listOperatorIssues(fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${OPERATOR_REPOSITORY}/issues?state=open&per_page=100&sort=created&direction=desc`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "FateDrop-Local-Radar-Operator/1.0",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`GitHub operator intake HTTP ${response.status}`);
  const issues = await response.json();
  return Array.isArray(issues)
    ? issues.filter((issue) => !issue?.pull_request && issue?.state === "open" && issue?.user?.login === OPERATOR_LOGIN && String(issue?.title || "").startsWith(ISSUE_PREFIX))
    : [];
}

const processedFingerprints = new Map();
let polling = false;
let watcherStarted = false;

export async function pollOperatorIssues({ store, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!store) return { status: "disabled", reason: "store_required" };
  if (polling) return { status: "busy" };
  polling = true;
  try {
    const issues = await listOperatorIssues(fetchImpl);
    const results = [];
    for (const issue of issues) {
      const fingerprint = issueFingerprint(issue);
      if (processedFingerprints.get(issue.number) === fingerprint) continue;
      try {
        const result = await processOperatorIssue({ issue, store, fetchImpl, now });
        results.push({ issue: issue.number, ...result });
        if (result.status === "published") processedFingerprints.set(issue.number, fingerprint);
      } catch (error) {
        const reason = String(error?.message || error);
        results.push({ issue: issue.number, status: "invalid", reason });
        processedFingerprints.set(issue.number, fingerprint);
      }
    }
    if (results.length) console.log("[signal-engine] Local Radar operator intake", results);
    return { status: "ok", issues: issues.length, results };
  } catch (error) {
    console.error("[signal-engine] Local Radar operator intake failed", { error: String(error?.message || error) });
    return { status: "failed", error: String(error?.message || error) };
  } finally {
    polling = false;
  }
}

export function startOperatorLocalRadarIntake({ store, fetchImpl = fetch } = {}) {
  if (watcherStarted) return { started: false, reason: "already_started" };
  if (!env.databaseUrl || env.store !== "postgres") return { started: false, reason: "postgres_not_configured" };
  if (!store) return { started: false, reason: "store_required" };

  watcherStarted = true;
  const timer = setTimeout(() => { void pollOperatorIssues({ store, fetchImpl }); }, POLL_START_DELAY_MS);
  timer.unref();
  const interval = setInterval(() => { void pollOperatorIssues({ store, fetchImpl }); }, POLL_INTERVAL_MS);
  interval.unref();
  return { started: true, intervalMs: POLL_INTERVAL_MS, startDelayMs: POLL_START_DELAY_MS };
}
