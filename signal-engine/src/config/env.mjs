import path from "node:path";

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
  scanIntervalSeconds: Math.max(60, int("FATEDROP_SCAN_INTERVAL_SECONDS", 300)),
  scanOnStart: bool("FATEDROP_SCAN_ON_START", false),
  scanConcurrency: Math.max(1, Math.min(4, int("FATEDROP_SCAN_CONCURRENCY", 2))),
  fetchTimeoutMs: Math.max(3000, int("FATEDROP_FETCH_TIMEOUT_MS", 15000)),
  userAgent: process.env.FATEDROP_FETCH_USER_AGENT || "FateDrop/0.1 (+https://fate-drop.com; catalogue-monitor)",
  suppressBaselineSignals: bool("FATEDROP_SUPPRESS_BASELINE_SIGNALS", true),
  retailers: {
    pokemonCenterUk: bool("FATEDROP_RETAILER_POKEMON_CENTER_UK", true),
    smythsUk: bool("FATEDROP_RETAILER_SMYTHS_UK", true),
    chaosCards: bool("FATEDROP_RETAILER_CHAOS_CARDS", true),
  },
};
