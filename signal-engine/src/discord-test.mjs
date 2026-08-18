import { env } from "./config/env.mjs";
import { sendDiscordSignal } from "./notifications/discord.mjs";

function stop(message) {
  console.error(`STOP - ${message}`);
  process.exit(1);
}

if (!env.discord.enabled) stop("set FATEDROP_DISCORD_ENABLED=true");
if (!env.discord.botToken) stop("DISCORD_BOT_TOKEN is missing");
if (!env.discord.premiumDropsChannelId) stop("DISCORD_PREMIUM_DROPS_CHANNEL_ID is missing");

const now = Math.floor(Date.now() / 1000);
const signal = {
  id: `discord-test-${now}`,
  state: "manifested",
  productId: "test-product",
  offerId: "test-offer",
  retailerId: "fatedrop-test",
  retailerName: "FateDrop Signal Engine",
  title: "Discord delivery test",
  productType: "sealed",
  url: "https://www.pokemoncenter.com/en-gb",
  imageUrl: null,
  pricePence: 4999,
  rrpPence: 4999,
  postagePence: null,
  deliveredPricePence: null,
  markupPercent: 0,
  stockStatus: "in_stock",
  previousStockStatus: "out_of_stock",
  confidence: 1,
  detectedAt: now,
  reason: "Test Manifested signal from the FateDrop Signal Engine. No real stock event occurred.",
  evidence: [{ kind: "test", value: "manual Discord delivery test" }],
};

try {
  const result = await sendDiscordSignal(signal);
  if (!result.sent) stop(`Discord test was not sent (${result.reason || "unknown reason"})`);
  console.log(`PASS - Discord test sent${result.messageId ? ` (message ${result.messageId})` : ""}`);
} catch (error) {
  stop(error?.message || String(error));
}
