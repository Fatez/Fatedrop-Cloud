import crypto from "node:crypto";
import { runWithRetailerScanDeadline } from "../core/scan-deadline.mjs";
import { createStore } from "../stores/index.mjs";
import { dryRunRetailer } from "./dry-run.mjs";
import { PostgresRetailerRegistry } from "./postgres-registry.mjs";
import { ADAPTER_TYPES, RETAILER_STATES } from "./registry.mjs";

export const RETAILER_QUALIFICATION_MODE = "qualification_dry_run";
export const RETAILER_QUALIFICATION_COOLDOWN_SECONDS = 24 * 60 * 60;
export const RETAILER_QUALIFICATION_MAX_PAGES = 4;
export const RETAILER_QUALIFICATION_LIMIT = 14;
export const RETAILER_QUALIFICATION_DEADLINE_MS = 60_000;

function runId(retailerId, now) {
  const digest = crypto.createHash("sha256").update(`${retailerId}:${now}:${RETAILER_QUALIFICATION_MODE}`).digest("hex").slice(0, 16);
  return `rq_${now}_${digest}`;
}

function boundedCandidate(retailer, maxPages) {
  const currentMax = Number(retailer?.catalogue?.runtime?.maxPages);
  const safeMaxPages = Math.max(1, Math.min(maxPages, Number.isFinite(currentMax) ? currentMax : maxPages));
  return {
    ...retailer,
    catalogue: {
      ...retailer.catalogue,
      runtime: {
        ...retailer.catalogue.runtime,
        maxPages: safeMaxPages,
        delayMs: Math.max(900, Number(retailer?.catalogue?.runtime?.delayMs) || 1800),
      },
    },
  };
}

export function candidateQualificationDecision(retailer, lastRunAt, {
  now = Math.floor(Date.now() / 1000),
  cooldownSeconds = RETAILER_QUALIFICATION_COOLDOWN_SECONDS,
} = {}) {
  if (![RETAILER_STATES.CANDIDATE, RETAILER_STATES.QUALIFYING].includes(retailer?.state)) return { eligible: false, reason: "lifecycle-state" };
  if (![ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer?.adapterType)) return { eligible: false, reason: "adapter-not-structured" };
  if (!retailer?.catalogue?.feedUrl) return { eligible: false, reason: "feed-url-missing" };
  if (Number.isFinite(lastRunAt) && now - lastRunAt < cooldownSeconds) {
    return { eligible: false, reason: "cooldown", nextAt: lastRunAt + cooldownSeconds };
  }
  return { eligible: true, reason: "due" };
}

export async function runCandidateQualificationCycle({
  databaseUrl = "",
  store = null,
  registry = null,
  dryRunFn = dryRunRetailer,
  now = Math.floor(Date.now() / 1000),
  limit = RETAILER_QUALIFICATION_LIMIT,
  cooldownSeconds = RETAILER_QUALIFICATION_COOLDOWN_SECONDS,
  maxPages = RETAILER_QUALIFICATION_MAX_PAGES,
  deadlineMs = RETAILER_QUALIFICATION_DEADLINE_MS,
} = {}) {
  if (!registry && !databaseUrl) return { enabled: false, reason: "database-url-missing", candidates: 0, attempted: 0, succeeded: 0, failed: 0, results: [] };
  let source = registry;
  if (!source) {
    const canonicalStore = store || createStore();
    if (typeof canonicalStore?.pool !== "function") throw new Error("Retailer qualification requires the canonical PostgreSQL store");
    source = new PostgresRetailerRegistry(databaseUrl, { poolProvider: () => canonicalStore.pool() });
  }
  const candidates = await source.list({
    states: [RETAILER_STATES.CANDIDATE, RETAILER_STATES.QUALIFYING],
    adapters: [ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE],
    limit: 500,
  });
  const ids = candidates.map((retailer) => retailer.id);
  const recent = typeof source.latestMonitorRunTimes === "function"
    ? await source.latestMonitorRunTimes({ retailerIds: ids, mode: RETAILER_QUALIFICATION_MODE })
    : new Map();

  const due = candidates
    .map((retailer) => ({ retailer, lastRunAt: recent.get(retailer.id) ?? null }))
    .filter(({ retailer, lastRunAt }) => candidateQualificationDecision(retailer, lastRunAt, { now, cooldownSeconds }).eligible)
    .sort((a, b) => (a.lastRunAt ?? 0) - (b.lastRunAt ?? 0) || a.retailer.name.localeCompare(b.retailer.name))
    .slice(0, Math.max(1, Math.min(50, limit)));

  const results = [];
  for (const { retailer } of due) {
    const startedAt = Math.floor(Date.now() / 1000);
    const id = runId(retailer.id, startedAt);
    try {
      const inspected = boundedCandidate(retailer, maxPages);
      const outcome = await runWithRetailerScanDeadline(
        () => dryRunFn(inspected),
        { retailerId: retailer.id, timeoutMs: deadlineMs },
      );
      const diagnostics = {
        mode: RETAILER_QUALIFICATION_MODE,
        productionWrites: false,
        feedApprovedAtRun: retailer.catalogue.feedApproved === true,
        feedUrl: retailer.catalogue.feedUrl,
        maxPages,
        ...outcome.diagnostics,
      };
      const qualified = diagnostics.adapterQualified === true && diagnostics.productsObserved > 0;
      const completedAt = Math.floor(Date.now() / 1000);
      await source.recordMonitorRun({
        runId: id,
        retailerId: retailer.id,
        startedAt,
        completedAt,
        status: qualified ? "success" : "failed",
        pagesScanned: diagnostics.pagesScanned,
        productsObserved: diagnostics.productsObserved,
        catalogueComplete: diagnostics.catalogueComplete,
        published: false,
        failureCode: qualified ? null : "qualification_no_products",
        failureDetail: qualified ? null : "Candidate feed returned no usable products during bounded dry-run qualification.",
        diagnostics,
      });
      results.push({ retailerId: retailer.id, retailerName: retailer.name, ok: qualified, diagnostics });
    } catch (error) {
      const completedAt = Math.floor(Date.now() / 1000);
      const detail = String(error?.message || error);
      await source.recordMonitorRun({
        runId: id,
        retailerId: retailer.id,
        startedAt,
        completedAt,
        status: "failed",
        pagesScanned: 0,
        productsObserved: 0,
        catalogueComplete: false,
        published: false,
        failureCode: error?.code || "qualification_failed",
        failureDetail: detail,
        diagnostics: {
          mode: RETAILER_QUALIFICATION_MODE,
          productionWrites: false,
          feedApprovedAtRun: retailer.catalogue.feedApproved === true,
          feedUrl: retailer.catalogue.feedUrl,
          maxPages,
        },
      });
      results.push({ retailerId: retailer.id, retailerName: retailer.name, ok: false, error: detail });
    }
  }

  return {
    enabled: true,
    candidates: candidates.length,
    due: due.length,
    attempted: results.length,
    succeeded: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    results,
  };
}
