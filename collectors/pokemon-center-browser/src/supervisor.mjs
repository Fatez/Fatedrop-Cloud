import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  supervisorAccessCooldownMs,
  supervisorIntervalMs,
  supervisorProbeTimeoutMs,
  supervisorProbeUrl,
  supervisorRestartDelayMs,
} from "./supervisor-runtime.mjs";

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
const restartBaseMs = Math.max(30_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_RESTART_BASE_MS || "60000", 10) || 60_000);
const restartMaxMs = Math.max(restartBaseMs, Math.min(3_600_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_RESTART_MAX_MS || "1800000", 10) || 1_800_000));
const stableRuntimeMs = Math.max(300_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_STABLE_RUNTIME_MS || "1200000", 10) || 1_200_000);
const repeatedFailureCooldownMs = Math.max(300_000, Math.min(3_600_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_REPEATED_FAILURE_COOLDOWN_MS || "600000", 10) || 600_000));
const safeMinimumCycleMs = Math.max(300_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_CYCLE_MS || "300000", 10) || 300_000);
const safeMinimumSettleMs = Math.max(4_000, Number.parseInt(process.env.FATEDROP_COLLECTOR_SETTLE_MS || "4000", 10) || 4_000);
const accessCooldowns = {
  queue: Number.parseInt(process.env.FATEDROP_COLLECTOR_QUEUE_COOLDOWN_MS || "300000", 10),
  security: Number.parseInt(process.env.FATEDROP_COLLECTOR_SECURITY_COOLDOWN_MS || "900000", 10),
  access_blocked: Number.parseInt(process.env.FATEDROP_COLLECTOR_ACCESS_BLOCK_COOLDOWN_MS || "3600000", 10),
};

// The supervisor owns the safe lower bounds for the long-running host. A local
// .env may raise these values but cannot make supervised scans more aggressive.
process.env.FATEDROP_COLLECTOR_CYCLE_MS = String(safeMinimumCycleMs);
process.env.FATEDROP_COLLECTOR_SETTLE_MS = String(safeMinimumSettleMs);

let child = null;
let stopping = false;
let lastCdpHealthy = null;
let restartNotBefore = 0;
let restartCount = 0;
let childStartedAt = 0;
let outputWindow = "";
let cooldownStopTimer = null;
let lastCooldownKind = null;
let rejectedRotations = 0;
let lastRejectedCycle = null;

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

function accessKindFromOutput(text) {
  const sample = text.toLowerCase();
  if (sample.includes("access block detected") || sample.includes("temporarily blocked") || sample.includes("request blocked")) return "access_blocked";
  if (sample.includes("security verification detected") || sample.includes("verify you are human") || sample.includes("security check")) return "security";
  if (sample.includes("queue / traffic control detected") || sample.includes("waiting room") || sample.includes("you are now in line")) return "queue";
  return null;
}

function scheduleCollectorStop(reason) {
  if (cooldownStopTimer) clearTimeout(cooldownStopTimer);
  cooldownStopTimer = setTimeout(() => {
    cooldownStopTimer = null;
    stopCollector(reason);
  }, 10_000);
  cooldownStopTimer.unref?.();
}

function armAccessCooldown(kind) {
  if (!kind || (kind === lastCooldownKind && Date.now() < restartNotBefore)) return;
  const delayMs = supervisorAccessCooldownMs(kind, accessCooldowns);
  restartNotBefore = Math.max(restartNotBefore, Date.now() + delayMs);
  lastCooldownKind = kind;
  console.log(`🧊 Retailer ${kind.replaceAll("_", " ")} detected; pausing collector restarts for at least ${Math.ceil(delayMs / 60_000)} minute(s) to avoid repeated access pressure.`);
  scheduleCollectorStop(`retailer ${kind.replaceAll("_", " ")} cooldown`);
}

function noteRejectedRotation(text) {
  const matches = [...text.matchAll(/Rotation\s+(\d+)\s+rejected:/gi)];
  const latest = matches.at(-1)?.[1] ?? null;
  if (!latest || latest === lastRejectedCycle) return;
  lastRejectedCycle = latest;
  rejectedRotations += 1;

  if (rejectedRotations < 2) return;
  restartNotBefore = Math.max(restartNotBefore, Date.now() + repeatedFailureCooldownMs);
  console.log(`🧯 ${rejectedRotations} rejected rotations detected in this collector session; pausing for at least ${Math.ceil(repeatedFailureCooldownMs / 60_000)} minute(s) before trying again.`);
  scheduleCollectorStop("repeated rejected rotations cooldown");
}

function noteSuccessfulRotation(text) {
  if (!/Rotation\s+\d+\s+ingested/gi.test(text)) return;
  rejectedRotations = 0;
  lastRejectedCycle = null;
}

function relayCollectorOutput(stream, destination) {
  stream.on("data", (chunk) => {
    destination.write(chunk);
    outputWindow = `${outputWindow}${chunk.toString("utf8")}`.slice(-8_000);
    noteSuccessfulRotation(outputWindow);
    noteRejectedRotation(outputWindow);
    const kind = accessKindFromOutput(outputWindow);
    if (kind) armAccessCooldown(kind);
  });
}

function launchCollector() {
  if (stopping || child || Date.now() < restartNotBefore) return;
  console.log("🚀 Chrome CDP is ready; starting FateDrop Pokémon Center collector...");
  outputWindow = "";
  lastCooldownKind = null;
  rejectedRotations = 0;
  lastRejectedCycle = null;
  childStartedAt = Date.now();
  child = spawn(process.execPath, [collectorEntry], {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });
  relayCollectorOutput(child.stdout, process.stdout);
  relayCollectorOutput(child.stderr, process.stderr);
  child.once("exit", (code, signal) => {
    const runtimeMs = Math.max(0, Date.now() - childStartedAt);
    console.log(`🧭 Pokémon Center collector exited · code=${code ?? "null"} · signal=${signal ?? "none"} · runtime=${Math.round(runtimeMs / 1000)}s`);
    child = null;
    childStartedAt = 0;
    outputWindow = "";
    if (stopping) return;

    restartCount = runtimeMs >= stableRuntimeMs ? 0 : restartCount + 1;
    const delayMs = supervisorRestartDelayMs(Math.max(0, restartCount - 1), { baseMs: restartBaseMs, maxMs: restartMaxMs });
    restartNotBefore = Math.max(restartNotBefore, Date.now() + delayMs);
    console.log(`🧯 Collector restart backoff armed for ${Math.ceil((restartNotBefore - Date.now()) / 1000)}s; repeated crashes cannot create a tight retry loop.`);
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
  console.log(`🐢 Safe full-catalogue pacing: ≥${Math.round(safeMinimumCycleMs / 60_000)}m per rotation · ≥${(safeMinimumSettleMs / 1000).toFixed(1)}s settle between catalogue page actions`);
  console.log(`🧯 Restart backoff: ${Math.round(restartBaseMs / 1000)}s base → ${Math.round(restartMaxMs / 60_000)}m max`);
  console.log("🛡️  Access-control cooldowns are fail-closed: queue/security/block evidence pauses retries rather than bypassing retailer controls.");

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
  if (cooldownStopTimer) clearTimeout(cooldownStopTimer);
  console.log(`\n${signal} received; stopping collector supervisor...`);
  stopCollector("supervisor shutdown");
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

supervise().catch((error) => {
  console.error(`❌ Collector supervisor failed: ${error?.message || error}`);
  process.exitCode = 1;
});
