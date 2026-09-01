import { env } from "./config/env.mjs";
import { retailers as staticRetailers } from "./config/retailers.mjs";
import { loadRuntimeRetailers } from "./retailers/runtime.mjs";
import { createStore } from "./stores/index.mjs";
import { loadSignalYieldReport } from "./telemetry/signal-yield-report.mjs";

const store = createStore();
const configuredRetailers = await loadRuntimeRetailers({
  staticRetailers,
  registryEnabled: env.retailerRegistryEnabled,
  databaseUrl: env.databaseUrl,
  store,
});
const requestedHours = Number.parseInt(process.argv[2] || "24", 10);
const report = await loadSignalYieldReport(store, {
  hours: Number.isFinite(requestedHours) ? requestedHours : 24,
  configuredRetailers,
  globalIntervalSeconds: env.scanIntervalSeconds,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
