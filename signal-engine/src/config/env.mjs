import path from "node:path";
import process from "node:process";

try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export const env = {
  port: int("PORT", 8787),
  apiToken: process.env.FATEDROP_SIGNAL_API_TOKEN || "",
  ingestSecret: process.env.FATEDROP_SIGNAL_INGEST_SECRET || "",
  store: process.env.FATEDROP_SIGNAL_STORE || "file",
  filePath: path.resolve(process.cwd(), process.env.FATEDROP_SIGNAL_FILE || "data/signal-engine.json"),
  databaseUrl: process.env.DATABASE_URL || "",
  retailerRegistryEnabled: bool("FATEDROP_RETAILER_REGISTRY_ENABLED", false),
  scanIntervalSeconds: Math.max(60, int("FATEDROP_SCAN_INTERVAL_SECONDS", 300)),
  scanOnStart: bool("FATEDROP_SCAN_ON_START", false),
  scanConcurrency: Math.max(1, Math.min(4, int("FATEDROP_SCAN_CONCURRENCY", 2))),
  fetchTimeoutMs: Math.max(3000, int("FATEDROP_FETCH_TIMEOUT_MS", 15000)),
  userAgent: process.env.FATEDROP_FETCH_USER_AGENT || "FateDrop/0.1 (+https://fate-drop.com; catalogue-monitor)",
  suppressBaselineSignals: bool("FATEDROP_SUPPRESS_BASELINE_SIGNALS", true),
  hostedFateFind: {
    enabled: bool("FATEDROP_HOSTED_FATEFIND_ENABLED", false),
    maxFindsPerRun: Math.max(1, Math.min(10000, int("FATEDROP_HOSTED_FATEFIND_MAX_PER_RUN", 2000))),
    outboxBatchSize: Math.max(1, Math.min(500, int("FATEDROP_NOTIFICATION_BATCH_SIZE", 100))),
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || "",
  },
  discord: {
    enabled: bool("FATEDROP_DISCORD_ENABLED", false),
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    premiumDropsChannelId: process.env.DISCORD_PREMIUM_DROPS_CHANNEL_ID || "",
  },
  retailers: {
    pokemonCenterUk: bool("FATEDROP_RETAILER_POKEMON_CENTER_UK", true),
    smythsUk: bool("FATEDROP_RETAILER_SMYTHS_UK", true),
    chaosCards: bool("FATEDROP_RETAILER_CHAOS_CARDS", true),
  },
};
