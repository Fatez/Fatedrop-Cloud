import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { scanAll } from "./core/engine.mjs";
import { createHttpServer } from "./http/server.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { createStore } from "./stores/index.mjs";

const store = createStore();
const retailers = await loadRuntimeRetailers({
  staticRetailers,
  registryEnabled: env.retailerRegistryEnabled,
  databaseUrl: env.databaseUrl,
});
const server = createHttpServer({ store });
let scanning = false;
async function scheduledScan() {
  if (scanning) return;
  scanning = true;
  try {
    const results = await scanAll({ retailers, store });
    const website = await publishWebsiteSnapshot({ store });
    console.log(`[signal-engine] scan ${new Date().toISOString()}`, {
      registryEnabled: env.retailerRegistryEnabled,
      retailers: results.map((r)=>({retailer:r.retailerId,products:r.productsSeen,signals:r.signalsCreated,error:r.error})),
      website,
    });
  } finally { scanning = false; }
}
server.listen(env.port, () => console.log(`[signal-engine] listening on :${env.port}; ${retailers.length} retailer adapters enabled; registry=${env.retailerRegistryEnabled ? "on" : "off"}`));
if (env.scanOnStart) scheduledScan();
setInterval(scheduledScan, env.scanIntervalSeconds * 1000).unref();
