import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { scanAll } from "./core/engine.mjs";
import { runHostedFateFindCycle } from "./hosted/run.mjs";
import { createFateDropHttpServer } from "./http/fatedrop-server.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { bootstrapAsmodeeRrp } from "./rrp/asmodee-bootstrap.mjs";
import { createStore } from "./stores/index.mjs";
import { loadSignalHealthSummary } from "./telemetry/signal-health-summary.mjs";

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
async function scheduledScan() {
  if (scanning) return;
  scanning = true;
  try {
    const results = await scanAll({ retailers, store });
    const website = await publishWebsiteSnapshot({ store });
    const hostedFateFind = await runHostedFateFindCycle().catch((error) => ({ enabled: env.hostedFateFind.enabled, error: String(error?.message || error) }));
    console.log(`[signal-engine] scan ${new Date().toISOString()}`, {
      registryEnabled: env.retailerRegistryEnabled,
      retailers: results.map((r)=>({retailer:r.retailerId,products:r.productsSeen,signals:r.signalsCreated,error:r.error})),
      website,
      hostedFateFind,
    });
  } finally { scanning = false; }
}

async function bootstrapAuthoritativeRrp() {
  try {
    const outcome = await bootstrapAsmodeeRrp({ store, databaseUrl: env.databaseUrl });
    console.log("[signal-engine] Asmodee RRP bootstrap", outcome);
  } catch (error) {
    console.error("[signal-engine] Asmodee RRP bootstrap failed", { error: String(error?.message || error) });
  }
}

server.listen(env.port, () => {
  console.log(`[signal-engine] listening on :${env.port}; ${retailers.length} retailer adapters enabled; registry=${env.retailerRegistryEnabled ? "on" : "off"}; hosted FateFind=${env.hostedFateFind.enabled ? "on" : "off"}`);
  void bootstrapAuthoritativeRrp();
});
if (env.scanOnStart) scheduledScan();
setInterval(scheduledScan, env.scanIntervalSeconds * 1000).unref();
