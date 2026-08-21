import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { supervisorIntervalMs, supervisorProbeTimeoutMs, supervisorProbeUrl } from "./supervisor-runtime.mjs";

try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const chromeCdpUrl = process.env.FATEDROP_CHROME_CDP_URL || "http://127.0.0.1:9222";
const probeUrl = supervisorProbeUrl(chromeCdpUrl);
const intervalMs = supervisorIntervalMs(process.env.FATEDROP_COLLECTOR_SUPERVISOR_INTERVAL_MS);
const probeTimeoutMs = supervisorProbeTimeoutMs(process.env.FATEDROP_COLLECTOR_SUPERVISOR_TIMEOUT_MS);
const collectorEntry = fileURLToPath(new URL("./index.mjs", import.meta.url));

let child = null;
let stopping = false;
let lastCdpHealthy = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpHealthy() {
  try {
    const response = await fetch(probeUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function launchCollector() {
  if (stopping || child) return;
  console.log("🚀 Chrome CDP is ready; starting FateDrop Pokémon Center collector...");
  child = spawn(process.execPath, [collectorEntry], {
    stdio: "inherit",
    env: process.env,
  });
  child.once("exit", (code, signal) => {
    console.log(`🧭 Pokémon Center collector exited · code=${code ?? "null"} · signal=${signal ?? "none"}`);
    child = null;
  });
  child.once("error", (error) => {
    console.error(`❌ Could not launch Pokémon Center collector: ${error?.message || error}`);
  });
}

function stopCollector(reason) {
  if (!child) return;
  console.log(`🛑 Stopping collector: ${reason}`);
  child.kill("SIGTERM");
}

async function supervise() {
  console.log("🛰️  FateDrop Pokémon Center collector supervisor");
  console.log(`🔌 Watching Chrome CDP: ${probeUrl}`);
  console.log(`⏱️  Supervisor probe interval: ${Math.round(intervalMs / 1000)}s`);

  while (!stopping) {
    const healthy = await cdpHealthy();
    if (healthy !== lastCdpHealthy) {
      console.log(healthy
        ? "✅ Chrome CDP available"
        : "⚠️  Chrome CDP unavailable; FateDrop will wait rather than publish stale browser observations");
      lastCdpHealthy = healthy;
    }

    if (healthy && !child) launchCollector();
    if (!healthy && child) stopCollector("Chrome CDP connection disappeared");

    await sleep(intervalMs);
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received; stopping collector supervisor...`);
  stopCollector("supervisor shutdown");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

supervise().catch((error) => {
  console.error(`❌ Collector supervisor failed: ${error?.message || error}`);
  process.exitCode = 1;
});
