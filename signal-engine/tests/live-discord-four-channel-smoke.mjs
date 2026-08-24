import { env } from "../src/config/env.mjs";
import {
  companionForSignal,
  discordBotTokenForState,
  discordChannelForState,
  sendDiscordSignal,
} from "../src/notifications/discord.mjs";

const states = ["whisper", "echo", "manifested", "vanished"];

function testSignal(state, index) {
  const now = Math.floor(Date.now() / 1000);
  const companion = companionForSignal(state);
  return {
    id: `live-smoke-${state}-${now}`,
    state,
    kind: state === "whisper"
      ? "catalogue_new"
      : state === "echo"
        ? "queue"
        : state === "manifested"
          ? "restock"
          : "sold_out",
    alertClass: "primary_drop",
    retailerId: "fatedrop-test",
    retailerName: "FateDrop Test Network",
    retailerSku: `TEST-${index + 1}`,
    productId: "prd-live-smoke",
    offerId: `off-live-smoke-${state}`,
    title: `[TEST] ${companion} ${state.toUpperCase()} channel verification`,
    productType: "elite_trainer_box",
    url: "https://fate-drop.com",
    imageUrl: null,
    pricePence: 4999,
    rrpPence: 4999,
    postagePence: 0,
    deliveredPricePence: 4999,
    markupPercent: 0,
    stockStatus: state === "vanished" ? "out_of_stock" : state === "whisper" || state === "echo" ? "coming_soon" : "in_stock",
    previousStockStatus: state === "manifested" ? "out_of_stock" : state === "vanished" ? "in_stock" : null,
    confidence: 0.99,
    detectedAt: now + index,
    reason: "Intentional FateDrop live channel smoke test — not a real stock event.",
    observedDurationSeconds: state === "vanished" ? 754 : null,
    evidence: [
      { kind: "signal_kind", value: state === "vanished" ? "sold_out" : state, lifecycle: state, observedAt: now },
      { kind: "signal_alert_class", value: "primary_drop", observedAt: now },
      { kind: "test_event", value: "live_discord_four_channel_smoke", observedAt: now },
    ],
  };
}

const missing = [];
for (const state of states) {
  if (!discordChannelForState(state)) missing.push(`${state}:channel`);
  if (!discordBotTokenForState(state)) missing.push(`${state}:bot-token`);
}

if (!env.discord.enabled) missing.push("FATEDROP_DISCORD_ENABLED");
if (missing.length) {
  throw new Error(`Live Discord smoke test preflight failed; missing configuration: ${missing.join(", ")}`);
}

const results = [];
for (let index = 0; index < states.length; index += 1) {
  const state = states[index];
  const signal = testSignal(state, index);
  const result = await sendDiscordSignal(signal);
  if (!result.sent) throw new Error(`${state} test alert was not sent: ${result.reason || "unknown reason"}`);
  results.push({
    state,
    companion: companionForSignal(state),
    channelId: result.channelId,
    messageId: result.messageId,
  });
}

console.log("FateDrop four-channel live smoke test sent successfully.");
for (const result of results) {
  console.log(`${result.state}: ${result.companion} -> channel ${result.channelId} -> message ${result.messageId}`);
}
