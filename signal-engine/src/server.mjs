import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { scanAll } from "./core/engine.mjs";
import { runHostedFateFindCycle } from "./hosted/run.mjs";
import { createFateDropHttpServer } from "./http/fatedrop-server.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { bootstrapAsmodeeRrp } from "./rrp/asmodee-bootstrap.mjs";
import { createStore } from "./stores/index.mjs";

const RRP_AUTHORITY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const store = createStore();
const retailers = await loadRuntimeRetailers({
  staticRetailers,
  registryEnabled: env.retailerRegistryEnabled,
  databaseUrl: env.databaseUrl,
});
const server = createFateDropHttpServer({ store, retailers });
let scanning = false;
let refreshingAuthoritativeRrp = false;
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

server.listen(env.port, () => {
  console.log(`[signal-engine] listening on :${env.port}; ${retailers.length} retailer adapters enabled; registry=${env.retailerRegistryEnabled ? "on" : "off"}; hosted FateFind=${env.hostedFateFind.enabled ? "on" : "off"}`);
  void refreshAuthoritativeRrp();
});
if (env.scanOnStart) scheduledScan();
setInterval(scheduledScan, env.scanIntervalSeconds * 1000).unref();
setInterval(refreshAuthoritativeRrp, RRP_AUTHORITY_REFRESH_INTERVAL_MS).unref();
