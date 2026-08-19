import { env } from "./config/env.mjs";
import { retailers } from "./config/retailers.mjs";
import { scanAll } from "./core/engine.mjs";
import { runHostedFateFindCycle } from "./hosted/run.mjs";
import { createHttpServer } from "./http/server.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { createStore } from "./stores/index.mjs";

const store = createStore();
const server = createHttpServer({ store });
let scanning = false;
async function scheduledScan() {
  if (scanning) return;
  scanning = true;
  try {
    const results = await scanAll({ retailers, store });
    const website = await publishWebsiteSnapshot({ store });
    const hostedFateFind = await runHostedFateFindCycle().catch((error) => ({ enabled: env.hostedFateFind.enabled, error: String(error?.message || error) }));
    console.log(`[signal-engine] scan ${new Date().toISOString()}`, {
      retailers: results.map((r)=>({retailer:r.retailerId,products:r.productsSeen,signals:r.signalsCreated,error:r.error})),
      website,
      hostedFateFind,
    });
  } finally { scanning = false; }
}
server.listen(env.port, () => console.log(`[signal-engine] listening on :${env.port}; ${retailers.length} retailer adapters enabled; hosted FateFind ${env.hostedFateFind.enabled ? "enabled" : "disabled"}`));
if (env.scanOnStart) scheduledScan();
setInterval(scheduledScan, env.scanIntervalSeconds * 1000).unref();
