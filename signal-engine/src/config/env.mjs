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
function explicitlyConfigured(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) && String(process.env[name] ?? "").trim() !== "";
}

export function defaultProductionPostgresFeatureEnabled({ railwayEnvironmentName = "", store = "file", databaseUrl = "" } = {}) {
  return String(railwayEnvironmentName).trim().toLowerCase() === "production"
    && store === "postgres"
    && Boolean(String(databaseUrl || "").trim());
}

export function defaultHostedFateFindEnabled(options = {}) {
  return defaultProductionPostgresFeatureEnabled(options);
}

export function defaultRetailerRegistryEnabled(options = {}) {
  return defaultProductionPostgresFeatureEnabled(options);
}

const signalStore = process.env.FATEDROP_SIGNAL_STORE || "file";
const databaseUrl = process.env.DATABASE_URL || "";
const productionPostgresDefaults = {
  railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME || "",
  store: signalStore,
  databaseUrl,
};
const hostedFateFindExplicitlyConfigured = explicitlyConfigured("FATEDROP_HOSTED_FATEFIND_ENABLED");
const hostedFateFindProductionDefault = defaultHostedFateFindEnabled(productionPostgresDefaults);
const retailerRegistryProductionDefault = defaultRetailerRegistryEnabled(productionPostgresDefaults);

const amazonCreatorsClientId = process.env.AMAZON_CREATORS_CLIENT_ID || "";
const amazonCreatorsClientSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET || "";
const amazonCreatorsPartnerTag = process.env.AMAZON_CREATORS_PARTNER_TAG || "";
const amazonCreatorsConfigured = Boolean(
  amazonCreatorsClientId && amazonCreatorsClientSecret && amazonCreatorsPartnerTag,
);

const discordBotToken = process.env.DISCORD_BOT_TOKEN || "";
const discordBotTokens = Object.freeze({
  whisper: process.env.DISCORD_ORU_BOT_TOKEN || "",
  echo: process.env.DISCORD_FENN_BOT_TOKEN || "",
  manifested: process.env.DISCORD_KORU_BOT_TOKEN || "",
  vanished: process.env.DISCORD_NYXEN_BOT_TOKEN || process.env.DISCORD_NIXON_BOT_TOKEN || "",
});
const discordPremiumDropsChannelId = process.env.DISCORD_PREMIUM_DROPS_CHANNEL_ID || "";
const discordChannelIds = Object.freeze({
  whisper: process.env.DISCORD_WHISPER_CHANNEL_ID || "",
  echo: process.env.DISCORD_ECHO_CHANNEL_ID || "",
  manifested: process.env.DISCORD_MANIFESTED_CHANNEL_ID || "",
  vanished: process.env.DISCORD_VANISHED_CHANNEL_ID || "",
});
const discordConfigured = Boolean(
  (discordBotToken || Object.values(discordBotTokens).some(Boolean))
  && (discordPremiumDropsChannelId || Object.values(discordChannelIds).some(Boolean)),
);

export const env = {
  port: int("PORT", 8787),
  apiToken: process.env.FATEDROP_SIGNAL_API_TOKEN || "",
  ingestSecret: process.env.FATEDROP_SIGNAL_INGEST_SECRET || "",
  store: signalStore,
  filePath: path.resolve(process.cwd(), process.env.FATEDROP_SIGNAL_FILE || "data/signal-engine.json"),
  databaseUrl,
  retailerRegistryEnabled: bool("FATEDROP_RETAILER_REGISTRY_ENABLED", retailerRegistryProductionDefault),
  scanIntervalSeconds: Math.max(60, int("FATEDROP_SCAN_INTERVAL_SECONDS", 300)),
  scanOnStart: bool("FATEDROP_SCAN_ON_START", false),
  scanConcurrency: Math.max(1, Math.min(4, int("FATEDROP_SCAN_CONCURRENCY", 2))),
  scanDeadlineMs: Math.max(30_000, Math.min(300_000, int("FATEDROP_RETAILER_SCAN_DEADLINE_MS", 120_000))),
  fetchTimeoutMs: Math.max(3000, int("FATEDROP_FETCH_TIMEOUT_MS", 15000)),
  userAgent: process.env.FATEDROP_FETCH_USER_AGENT || "FateDrop/0.1 (+https://fate-drop.com; catalogue-monitor)",
  suppressBaselineSignals: bool("FATEDROP_SUPPRESS_BASELINE_SIGNALS", true),
  encounters: {
    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || "",
  },
  amazonCreators: {
    configured: amazonCreatorsConfigured,
    clientId: amazonCreatorsClientId,
    clientSecret: amazonCreatorsClientSecret,
    partnerTag: amazonCreatorsPartnerTag,
    marketplace: "www.amazon.co.uk",
  },
  hostedFateFind: {
    enabled: bool("FATEDROP_HOSTED_FATEFIND_ENABLED", hostedFateFindProductionDefault),
    explicitlyConfigured: hostedFateFindExplicitlyConfigured,
    productionDefault: hostedFateFindProductionDefault,
    maxFindsPerRun: Math.max(1, Math.min(10000, int("FATEDROP_HOSTED_FATEFIND_MAX_PER_RUN", 2000))),
    outboxBatchSize: Math.max(1, Math.min(500, int("FATEDROP_NOTIFICATION_BATCH_SIZE", 100))),
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || "",
  },
  discord: {
    enabled: bool("FATEDROP_DISCORD_ENABLED", discordConfigured),
    botToken: discordBotToken,
    botTokens: discordBotTokens,
    premiumDropsChannelId: discordPremiumDropsChannelId,
    channelIds: discordChannelIds,
  },
  retailers: {
    pokemonCenterUk: bool("FATEDROP_RETAILER_POKEMON_CENTER_UK", true),
    smythsUk: bool("FATEDROP_RETAILER_SMYTHS_UK", true),
    chaosCards: bool("FATEDROP_RETAILER_CHAOS_CARDS", true),
    hamleysUk: bool("FATEDROP_RETAILER_HAMLEYS_UK", true),
    asdaUk: bool("FATEDROP_RETAILER_ASDA_UK", true),
    tescoUk: bool("FATEDROP_RETAILER_TESCO_UK", true),
    entertainerUk: bool("FATEDROP_RETAILER_ENTERTAINER_UK", true),
    gameUk: bool("FATEDROP_RETAILER_GAME_UK", true),
    argosUk: bool("FATEDROP_RETAILER_ARGOS_UK", true),
    magicMadhouse: bool("FATEDROP_RETAILER_MAGIC_MADHOUSE", true),
    doubleSleeved: bool("FATEDROP_RETAILER_DOUBLE_SLEEVED", true),
    totalCards: bool("FATEDROP_RETAILER_TOTAL_CARDS", true),
    titanCards: bool("FATEDROP_RETAILER_TITAN_CARDS", true),
    eternaCards: bool("FATEDROP_RETAILER_ETERNA_CARDS", true),
    cardCollective: bool("FATEDROP_RETAILER_CARD_COLLECTIVE", true),
    jetCards: bool("FATEDROP_RETAILER_JET_CARDS", true),
    gatheringGames: bool("FATEDROP_RETAILER_GATHERING_GAMES", true),
    zatuGames: bool("FATEDROP_RETAILER_ZATU_GAMES", true),
    tgcCollectables: bool("FATEDROP_RETAILER_TGC_COLLECTABLES", true),
    amazonUk: bool("FATEDROP_RETAILER_AMAZON_UK", false),
  },
};