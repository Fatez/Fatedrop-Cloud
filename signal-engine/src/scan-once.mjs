import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { scanAll, scanRetailer } from "./core/engine.mjs";
import { retailerFailureBackoffDecision } from "./core/retailer-scan-backoff.mjs";
import { publishWebsiteSnapshot } from "./notifications/website.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { createStore } from "./stores/index.mjs";

const store = createStore();
const retailers = await loadRuntimeRetailers({
  staticRetailers,
  registryEnabled: env.retailerRegistryEnabled,
  databaseUrl: env.databaseUrl,
  store,
});
const requested = process.argv.find((x) => x.startsWith("--retailer="))?.split("=")[1];
const selected = requested ? retailers.filter((r) => r.id === requested) : retailers;
if (!selected.length) { console.error(`No enabled retailer matched ${requested || "configuration"}.`); process.exit(1); }

let healthRows = [];
try {
  healthRows = typeof store.listRetailers === "function" ? await store.listRetailers() : [];
} catch (error) {
  console.error("[monitor] persisted retailer backoff unavailable; continuing with normal scans", {
    error: String(error?.message || error),
  });
}
const healthById = new Map((healthRows || []).map((row) => [row.id, row]));
const now = Math.floor(Date.now() / 1000);
const backoffByRetailer = new Map(selected.map((retailer) => [
  retailer.id,
  retailerFailureBackoffDecision({ retailer, health: healthById.get(retailer.id), now }),
]));

const scanRetailerWithPersistedBackoff = async (args) => {
  const decision = backoffByRetailer.get(args.retailer.id);
  if (decision?.defer) {
    return {
      retailerId: args.retailer.id,
      retailerName: args.retailer.name,
      skipped: true,
      skipReason: "retailer_failure_backoff",
      failureClass: decision.failureClass,
      failureCode: decision.failureCode,
      recoveryAction: decision.recoveryAction,
      retryAt: decision.retryAt,
      signalsCreated: 0,
    };
  }
  return scanRetailer(args);
};

const results = await scanAll({ retailers: selected, store, scanRetailerFn: scanRetailerWithPersistedBackoff });
const website = await publishWebsiteSnapshot({ store });
console.log(JSON.stringify({ registryEnabled: env.retailerRegistryEnabled, results, website }, null, 2));
process.exit(results.some((r) => r.error) ? 2 : 0);
