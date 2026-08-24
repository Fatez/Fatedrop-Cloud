import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { scanAll, scanRetailer } from "./core/engine.mjs";
import { runWithRetailerScanDeadline } from "./core/scan-deadline.mjs";
import { retailerScanScheduleDecision } from "./core/scan-schedule.mjs";
import { runHostedFateFindCycle } from "./hosted/run.mjs";
import { createFateDropHttpServer } from "./http/fatedrop-server.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { bootstrapAsmodeeRrp } from "./rrp/asmodee-bootstrap.mjs";
import { createStore } from "./stores/index.mjs";
import { getBetaRuntimeReadiness, recordBetaRuntimeReadiness, refreshBetaRuntimeReadiness } from "./telemetry/beta-runtime-readiness.mjs";
import { getDiscordRouteHealth, refreshDiscordRouteHealth } from "./telemetry/discord-route-health.mjs";
import { buildFateFindEvaluatorPreflight } from "./telemetry/fatefind-evaluator-preflight.mjs";
import { loadSignalHealthSummary } from "./telemetry/signal-health-summary.mjs";

const RRP_AUTHORITY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DISCORD_ROUTE_HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_READINESS_INTERVAL_MS = 5 * 60 * 1000;
const store = createStore();
const retailers = await loadRuntimeRetailers({
  staticRetailers,
  registryEnabled: env.retailerRegistryEnabled,
  databaseUrl: env.databaseUrl,
});
const server = createFateDropHttpServer({ store, retailers });
const applicationHandler = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
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
    if (req.method === "GET" && url.pathname === "/api/fatefind-evaluator-preflight") {
      const summary = await buildFateFindEvaluatorPreflight(store);
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
    return applicationHandler(req, res);
  } catch (error) {
    if (res.headersSent) return res.end();
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "Signal health endpoint unavailable", detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined }));
  }
});
let scanning = false;
let refreshingAuthoritativeRrp = false;
let checkingDiscordRoutes = false;
let checkingBetaReadiness = false;

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

async function refreshAuthoritativeRrp() {
  if (refreshingAuthoritativeRrp) return;
  refreshingAuthoritativeRrp = true;
  try {
    const outcome = await bootstrapAsmodeeRrp({ store, databaseUrl: env.databaseUrl });
    console.log("[signal-engine] Asmodee RRP authority refresh", outcome);
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
  void refreshDiscordRoutes();
  void refreshBetaReadiness();
});
if (env.scanOnStart) scheduledScan();
setInterval(scheduledScan, env.scanIntervalSeconds * 1000).unref();
setInterval(refreshAuthoritativeRrp, RRP_AUTHORITY_REFRESH_INTERVAL_MS).unref();
setInterval(refreshDiscordRoutes, DISCORD_ROUTE_HEALTH_INTERVAL_MS).unref();
setInterval(refreshBetaReadiness, BETA_READINESS_INTERVAL_MS).unref();
