import { timingSafeEqual } from "node:crypto";
import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { reconcileProductDiscoveryWatch } from "./core/discovery-watch-reconcile.mjs";
import { scanAll, scanRetailer } from "./core/engine.mjs";
import { reconcileRrpLearningQueue } from "./core/rrp-learning-reconcile.mjs";
import { runWithRetailerScanDeadline } from "./core/scan-deadline.mjs";
import { retailerScanScheduleDecision } from "./core/scan-schedule.mjs";
import { countCanonicalRetailerLocations, listCanonicalRetailerLocations } from "./encounters/canonical-retailer-locations.mjs";
import { runHostedFateFindCycle, runHostedFateFindNow } from "./hosted/run.mjs";
import { createFateDropHttpServer } from "./http/fatedrop-server.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { reconcileMissingDiscordDeliveries } from "./notifications/discord-reconcile.mjs";
import { buildPublicRetailerDirectory, buildPublicRetailerProfile } from "./retailers/public-directory.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { bootstrapAsmodeeRrp } from "./rrp/asmodee-bootstrap.mjs";
import { createStore } from "./stores/index.mjs";
import { getBetaRuntimeReadiness, recordBetaRuntimeReadiness, refreshBetaRuntimeReadiness } from "./telemetry/beta-runtime-readiness.mjs";
import { getDiscordRouteHealth, refreshDiscordRouteHealth } from "./telemetry/discord-route-health.mjs";
import { buildFateFindEvaluatorPreflight } from "./telemetry/fatefind-evaluator-preflight.mjs";
import { loadSignalHealthSummary } from "./telemetry/signal-health-summary.mjs";
import { getWebsiteSnapshotHealth } from "./telemetry/website-snapshot-health.mjs";

const RRP_AUTHORITY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RRP_LEARNING_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const DISCORD_ROUTE_HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_READINESS_INTERVAL_MS = 5 * 60 * 1000;
const DISCORD_DELIVERY_RECONCILE_INTERVAL_MS = 60 * 1000;
const DISCOVERY_WATCH_RECONCILE_INTERVAL_MS = 60 * 1000;
const FATEFIND_PREFLIGHT_CACHE_MS = 60 * 1000;
const PRIVATE_DIAGNOSTIC_PATHS = new Set([
  "/api/status",
  "/api/discord-route-health",
  "/api/beta-readiness",
  "/api/website-snapshot-health",
  "/api/fatefind-evaluator-preflight",
  "/api/signal-health",
  "/internal/fatefind/evaluate",
]);
const store = createStore();
const retailers = await loadRuntimeRetailers({
  staticRetailers,
  registryEnabled: env.retailerRegistryEnabled,
  databaseUrl: env.databaseUrl,
  store,
});

function bearerToken(req) {
  const authorization = String(req?.headers?.authorization || "");
  return authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || "";
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""));
  const rightBytes = Buffer.from(String(right || ""));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function diagnosticAuthorized(req) {
  if (!env.apiToken) return false;
  const provided = bearerToken(req);
  return Boolean(provided) && constantTimeEqual(provided, env.apiToken);
}

async function readJsonBody(req, { maxBytes = 16 * 1024 } = {}) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

let fateFindPreflightCache = null;
let fateFindPreflightCachedAt = 0;
let fateFindPreflightInFlight = null;
async function cachedFateFindEvaluatorPreflight() {
  const now = Date.now();
  if (fateFindPreflightCache && now - fateFindPreflightCachedAt < FATEFIND_PREFLIGHT_CACHE_MS) {
    return fateFindPreflightCache;
  }
  if (fateFindPreflightInFlight) return fateFindPreflightInFlight;
  fateFindPreflightInFlight = buildFateFindEvaluatorPreflight(store)
    .then((summary) => {
      fateFindPreflightCache = summary;
      fateFindPreflightCachedAt = Date.now();
      return summary;
    })
    .finally(() => { fateFindPreflightInFlight = null; });
  return fateFindPreflightInFlight;
}

const server = createFateDropHttpServer({ store, retailers });
const applicationHandler = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (PRIVATE_DIAGNOSTIC_PATHS.has(url.pathname) && !diagnosticAuthorized(req)) {
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/internal/fatefind/evaluate") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ success: false, error: "Invalid JSON request body" }));
        return;
      }
      const fateFindId = typeof body?.fateFindId === "string" ? body.fateFindId.trim() : "";
      if (!fateFindId || fateFindId.length > 128) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ success: false, error: "A valid fateFindId is required" }));
        return;
      }
      const outcome = await runHostedFateFindNow(fateFindId);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ success: true, ...outcome }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/discord-route-health") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(getDiscordRouteHealth()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/beta-readiness") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(getBetaRuntimeReadiness()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/website-snapshot-health") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(getWebsiteSnapshotHealth()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/fatefind-evaluator-preflight") {
      const summary = await cachedFateFindEvaluatorPreflight();
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(summary));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/signal-health") {
      const days = Math.max(2, Math.min(30, Number.parseInt(url.searchParams.get("days") || "7", 10) || 7));
      const summary = await loadSignalHealthSummary(store, { days });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(summary));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/retailers") {
      const [healthRows, locationCounts] = await Promise.all([
        store.listRetailers(),
        countCanonicalRetailerLocations(store, { retailerIds: retailers.map((retailer) => retailer.id) }),
      ]);
      const requestedClass = String(url.searchParams.get("class") || "").trim().toLowerCase();
      const directory = buildPublicRetailerDirectory({ retailers, healthRows, locationCounts });
      const filtered = requestedClass
        ? directory.filter((retailer) => String(retailer.retailerClass).toLowerCase() === requestedClass)
        : directory;
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({
        success: true,
        retailers: filtered,
        disclaimer: "Monitor health describes FateDrop evidence freshness and is not proof that a retailer currently has stock. Physical presence is derived from canonical branch identity only.",
      }));
      return;
    }
    const retailerProfileMatch = req.method === "GET" ? url.pathname.match(/^\/api\/retailers\/([^/]+)$/) : null;
    if (retailerProfileMatch) {
      const retailerId = decodeURIComponent(retailerProfileMatch[1]);
      const healthRows = await store.listRetailers();
      const directory = buildPublicRetailerDirectory({ retailers, healthRows });
      const retailer = directory.find((item) => String(item.id) === retailerId) || null;
      if (!retailer) {
        res.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        res.end(JSON.stringify({ success: false, error: "Retailer not found" }));
        return;
      }
      const locations = await listCanonicalRetailerLocations(store, { retailerIds: [retailerId], limit: 2000 });
      const health = healthRows.find((item) => String(item.id) === retailerId) || null;
      const profile = buildPublicRetailerProfile({
        retailer,
        health,
        locations,
        monitoringConfigured: retailer.monitoring?.configured === true,
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({
        success: true,
        retailer: profile,
        disclaimer: "Retailer locations describe known canonical branches only. Their presence does not prove physical stock; exact-branch availability remains Local Radar evidence.",
      }));
      return;
    }
    return applicationHandler(req, res);
  } catch (error) {
    if (res.headersSent) return res.end();
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "Signal Engine endpoint unavailable", detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined }));
  }
});
let scanning = false;
let refreshingAuthoritativeRrp = false;
let reconcilingRrpLearning = false;
let checkingDiscordRoutes = false;
let checkingBetaReadiness = false;
let reconcilingDiscordDeliveries = false;
let reconcilingDiscoveryWatch = false;

async function scheduledScan() {
  if (scanning) return;
  scanning = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const healthRows = await store.listRetailers().catch((error) => {
      console.error("[signal-engine] retailer health preload failed; using normal scan schedule", { error: String(error?.message || error) });
      return [];
    });
    const healthByRetailer = new Map(healthRows.map((health) => [health.id, health]));
    const scanWithBackoff = async (args) => {
      const decision = retailerScanScheduleDecision(args.retailer, healthByRetailer.get(args.retailer.id), {
        now,
        globalIntervalSeconds: env.scanIntervalSeconds,
      });
      if (!decision.eligible) {
        return {
          retailerId: args.retailer.id,
          retailerName: args.retailer.name,
          skipped: true,
          skipReason: decision.reason,
          nextScanAt: decision.nextScanAt,
          signalsCreated: 0,
        };
      }
      const timeoutMs = Number(args.retailer?.scanDeadlineMs) || env.scanDeadlineMs;
      try {
        return await runWithRetailerScanDeadline(
          () => scanRetailer(args),
          { retailerId: args.retailer.id, timeoutMs },
        );
      } catch (error) {
        const detail = String(error?.message || error);
        if (typeof store.recordFailure === "function") {
          await store.recordFailure(args.retailer, error, Math.floor(Date.now() / 1000)).catch(() => null);
        }
        console.error("[signal-engine] retailer scan isolated by hard deadline", {
          retailer: args.retailer.id,
          timeoutMs,
          error: detail,
        });
        return {
          retailerId: args.retailer.id,
          retailerName: args.retailer.name,
          error: detail,
          failureCode: error?.code || "retailer_scan_deadline",
          signalsCreated: 0,
        };
      }
    };

    const results = await scanAll({ retailers, store, scanRetailerFn: scanWithBackoff });
    const website = await publishWebsiteSnapshot({ store });
    await refreshBetaRuntimeReadiness({ store }).catch((error) => console.error("[signal-engine] beta readiness refresh after website publish failed", { error: String(error?.message || error) }));
    const hostedFateFind = await runHostedFateFindCycle().catch((error) => ({ enabled: env.hostedFateFind.enabled, error: String(error?.message || error) }));
    if (hostedFateFind?.enabled && (Number(hostedFateFind?.evaluation?.created || 0) > 0 || hostedFateFind?.readiness?.ready === false)) {
      await recordBetaRuntimeReadiness({ store }).catch((error) => console.error("[signal-engine] beta readiness refresh failed", { error: String(error?.message || error) }));
    }
    console.log(`[signal-engine] scan ${new Date().toISOString()}`, {
      registryEnabled: env.retailerRegistryEnabled,
      retailers: results.map((r)=>({ retailer:r.retailerId, products:r.productsSeen, signals:r.signalsCreated, skipped:r.skipped, skipReason:r.skipReason, nextScanAt:r.nextScanAt, error:r.error })),
      website,
      hostedFateFind,
    });
  } finally { scanning = false; }
}

async function reconcileRrpLearning() {
  if (reconcilingRrpLearning) return;
  reconcilingRrpLearning = true;
  try {
    const outcome = await reconcileRrpLearningQueue({ store, limit: 100 });
    if (outcome.enabled && (outcome.resolved > 0 || outcome.conflicts > 0)) {
      console.log("[signal-engine] RRP learning reconciliation", outcome);
    }
  } catch (error) {
    console.error("[signal-engine] RRP learning reconciliation failed", { error: String(error?.message || error) });
  } finally {
    reconcilingRrpLearning = false;
  }
}

async function refreshAuthoritativeRrp() {
  if (refreshingAuthoritativeRrp) return;
  refreshingAuthoritativeRrp = true;
  try {
    const outcome = await bootstrapAsmodeeRrp({ store, databaseUrl: env.databaseUrl });
    console.log("[signal-engine] Asmodee RRP authority refresh", outcome);
    await reconcileRrpLearning();
  } catch (error) {
    console.error("[signal-engine] Asmodee RRP authority refresh failed", { error: String(error?.message || error) });
  } finally {
    refreshingAuthoritativeRrp = false;
  }
}

async function refreshBetaReadiness() {
  if (checkingBetaReadiness) return;
  checkingBetaReadiness = true;
  try {
    const readiness = await refreshBetaRuntimeReadiness({ store });
    console.log("[signal-engine] Beta runtime readiness heartbeat", {
      ready: readiness.ready,
      infrastructureReady: readiness.infrastructureReady,
      signalNetworkReady: readiness.signalNetworkReady,
      freshRetailers: readiness.signalNetwork?.freshRetailers,
      requiredFreshRetailers: readiness.signalNetwork?.minimumFreshRetailers,
    });
  } catch (error) {
    console.error("[signal-engine] Beta readiness heartbeat failed", { error: String(error?.message || error) });
  } finally {
    checkingBetaReadiness = false;
  }
}

async function reconcileDiscordDeliveries() {
  if (reconcilingDiscordDeliveries) return;
  reconcilingDiscordDeliveries = true;
  try {
    const outcome = await reconcileMissingDiscordDeliveries({ store });
    if (outcome.recovered > 0 || outcome.failed > 0) {
      console.log("[signal-engine] Discord lifecycle delivery reconciliation", outcome);
    }
  } catch (error) {
    console.error("[signal-engine] Discord lifecycle delivery reconciliation failed", {
      error: String(error?.message || error),
    });
  } finally {
    reconcilingDiscordDeliveries = false;
  }
}

async function reconcileDiscoveryWatchEvidence() {
  if (reconcilingDiscoveryWatch) return;
  reconcilingDiscoveryWatch = true;
  try {
    const outcome = await reconcileProductDiscoveryWatch({ store, retailers });
    if (outcome.signalsCreated > 0) {
      await publishWebsiteSnapshot({ store });
      await refreshBetaRuntimeReadiness({ store }).catch(() => null);
    }
    if (outcome.examined > 0 || outcome.failed > 0 || outcome.retried > 0) {
      console.log("[signal-engine] product discovery watch reconciliation", outcome);
    }
  } catch (error) {
    console.error("[signal-engine] product discovery watch reconciliation failed", {
      error: String(error?.message || error),
    });
  } finally {
    reconcilingDiscoveryWatch = false;
  }
}

async function refreshDiscordRoutes() {
  if (checkingDiscordRoutes) return;
  checkingDiscordRoutes = true;
  try {
    const outcome = await refreshDiscordRouteHealth();
    console.log("[signal-engine] Discord lifecycle route health", outcome);
    const runtime = await recordBetaRuntimeReadiness({ store });
    console.log("[signal-engine] Beta runtime readiness", { recorded: runtime.recorded, ready: runtime.readiness?.ready });
  } catch (error) {
    console.error("[signal-engine] Discord lifecycle route health failed", { error: String(error?.message || error) });
    await recordBetaRuntimeReadiness({ store }).catch(() => null);
  } finally {
    checkingDiscordRoutes = false;
  }
}

server.listen(env.port, () => {
  console.log(`[signal-engine] listening on :${env.port}; ${retailers.length} retailer adapters enabled; registry=${env.retailerRegistryEnabled ? "on" : "off"}; hosted FateFind=${env.hostedFateFind.enabled ? "on" : "off"}`);
  void refreshAuthoritativeRrp();
  void reconcileRrpLearning();
  void refreshDiscordRoutes();
  void refreshBetaReadiness();
  void reconcileDiscordDeliveries();
  void reconcileDiscoveryWatchEvidence();
});
if (env.scanOnStart) scheduledScan();
setInterval(scheduledScan, env.scanIntervalSeconds * 1000).unref();
setInterval(refreshAuthoritativeRrp, RRP_AUTHORITY_REFRESH_INTERVAL_MS).unref();
setInterval(reconcileRrpLearning, RRP_LEARNING_RECONCILE_INTERVAL_MS).unref();
setInterval(refreshDiscordRoutes, DISCORD_ROUTE_HEALTH_INTERVAL_MS).unref();
setInterval(refreshBetaReadiness, BETA_READINESS_INTERVAL_MS).unref();
setInterval(reconcileDiscordDeliveries, DISCORD_DELIVERY_RECONCILE_INTERVAL_MS).unref();
setInterval(reconcileDiscoveryWatchEvidence, DISCOVERY_WATCH_RECONCILE_INTERVAL_MS).unref();