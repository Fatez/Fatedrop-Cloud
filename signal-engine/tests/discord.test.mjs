import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordSignalMessage, dispatchDiscordSignals, isDiscordSignal, publicDiscordStage, sendDiscordSignal } from "../src/notifications/discord.mjs";

const marketSignal = {
  id: "sig-test", state: "manifested", kind: "availability_live", alertClass: "market_stock",
  retailerId: "titan-cards", retailerName: "Titan Cards", retailerSku: "SKU-123", offerId: "off-1", productId: "prd-1",
  title: "Test Booster Box", url: "https://example.com/product", imageUrl: null,
  pricePence: 4999, rrpPence: 4499, deliveredPricePence: 5499, markupPercent: 11.1135,
  confidence: 0.98, detectedAt: 1_700_000_000, stockStatus: "in_stock", reason: "Availability became verified",
};

const primarySignal = {
  ...marketSignal,
  id: "sig-primary",
  retailerId: "pokemon-center-uk",
  retailerName: "Pokémon Center UK",
  alertClass: "primary_drop",
  pricePence: 4499,
  deliveredPricePence: 4499,
  markupPercent: 0,
};

test("Discord delivers all four FateDrop lifecycle signals", () => {
  for (const state of ["whisper","echo","manifested","vanished"]) assert.equal(isDiscordSignal({ ...marketSignal, state }), true);
  assert.equal(isDiscordSignal({ ...marketSignal, state: "unknown" }), false);
});

test("Discord exposes the final canonical public lifecycle vocabulary", () => {
  assert.equal(publicDiscordStage("whisper"), "Whisper");
  assert.equal(publicDiscordStage("echo"), "Echo");
  assert.equal(publicDiscordStage("manifested"), "Manifested");
  assert.equal(publicDiscordStage("vanished"), "Vanished");
  assert.equal(publicDiscordStage("unknown"), null);
});

test("Primary Whisper is urgency-first early drop intelligence", () => {
  const message = buildDiscordSignalMessage({ ...primarySignal, state: "whisper", kind: "catalogue_new", stockStatus: "coming_soon" });
  assert.match(message.embeds[0].title, /WHISPER · PRIMARY \/ RRP/);
  assert.match(message.embeds[0].description, /Primary\/RRP retailer/);
  assert.equal(message.components[0].components[0].label, "Inspect early signal");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Retailer SKU")?.value, "SKU-123");
});

test("Primary Echo is readiness intelligence and never claims stock", () => {
  const message = buildDiscordSignalMessage({ ...primarySignal, state: "echo", kind: "queue", stockStatus: "coming_soon" });
  assert.match(message.embeds[0].title, /ECHO · PRIMARY \/ RRP/);
  assert.match(message.embeds[0].description, /get ready, but stock is not confirmed yet/i);
  assert.equal(message.components[0].components[0].label, "Get ready / inspect");
});

test("Primary Manifested is a direct buy-now alert", () => {
  const message = buildDiscordSignalMessage(primarySignal);
  assert.match(message.embeds[0].title, /MANIFESTED · PRIMARY \/ RRP/);
  assert.match(message.embeds[0].description, /live drop/i);
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Official RRP")?.value, "£44.99");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Vs RRP")?.value, "At RRP");
  assert.equal(message.components[0].components[0].label, "Buy now");
});

test("Market Manifested is value-first and labels premium versus RRP", () => {
  const message = buildDiscordSignalMessage(marketSignal);
  assert.match(message.embeds[0].title, /MANIFESTED · MARKET \/ INDIE/);
  assert.match(message.embeds[0].description, /Check the price against RRP/);
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Retailer")?.value, "Titan Cards");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Price")?.value, "£49.99");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Value vs RRP")?.value, "+11.1% above RRP");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Delivered price")?.value, "£54.99");
  assert.equal(message.components[0].components[0].label, "View market listing");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test("Market alert family can be recovered from persisted evidence", () => {
  const message = buildDiscordSignalMessage({ ...marketSignal, alertClass: undefined, evidence: [{ kind: "signal_alert_class", value: "market_stock" }] });
  assert.match(message.embeds[0].title, /MARKET \/ INDIE/);
});

test("Vanished uses family-aware alternatives wording", () => {
  const market = buildDiscordSignalMessage({ ...marketSignal, state: "vanished", stockStatus: "out_of_stock" });
  const primary = buildDiscordSignalMessage({ ...primarySignal, state: "vanished", stockStatus: "out_of_stock" });
  assert.equal(market.components[0].components[0].label, "Compare alternatives");
  assert.equal(primary.components[0].components[0].label, "View product / alternatives");
});

test("Discord omits unavailable RRP intelligence instead of showing fake values", () => {
  const message = buildDiscordSignalMessage({ ...marketSignal, rrpPence: null, markupPercent: null });
  assert.equal(message.embeds[0].fields.some((field) => field.name === "Official RRP"), false);
  assert.equal(message.embeds[0].fields.some((field) => field.name === "Value vs RRP"), false);
});

test("Discord delivery reports a missing bot token before the generic enable flag", async () => {
  const result = await sendDiscordSignal(marketSignal, { enabled: false, botToken: "", channelId: "123456789" });
  assert.deepEqual(result, { sent: false, reason: "missing_bot_token" });
});

test("Discord delivery reports a missing lifecycle channel before the generic enable flag", async () => {
  const result = await sendDiscordSignal(marketSignal, { enabled: false, botToken: "test-token", channelId: "" });
  assert.deepEqual(result, { sent: false, reason: "missing_lifecycle_channel_id" });
});

test("Discord delivery reports explicit disable when credentials are otherwise complete", async () => {
  const result = await sendDiscordSignal(marketSignal, { enabled: false, botToken: "test-token", channelId: "123456789" });
  assert.deepEqual(result, { sent: false, reason: "disabled" });
});

test("Discord delivery posts to configured channel", async () => {
  let request = null;
  const fetchImpl = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ id: "message-123" }), { status: 200, headers: { "content-type": "application/json" } }); };
  const result = await sendDiscordSignal(marketSignal, { fetchImpl, enabled: true, botToken: "test-token", channelId: "123456789" });
  assert.equal(result.sent, true);
  assert.equal(result.messageId, "message-123");
  assert.equal(request.url, "https://discord.com/api/v10/channels/123456789/messages");
  assert.equal(request.options.headers.Authorization, "Bot test-token");
});

test("Discord dispatch records successful provider delivery evidence", async () => {
  const attempts = [];
  const summary = await dispatchDiscordSignals([marketSignal], { fetchImpl: async () => new Response(JSON.stringify({ id: "message-456" }), { status: 200, headers: { "content-type": "application/json" } }), enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async (attempt) => attempts.push(attempt) });
  assert.equal(summary.sent, 1); assert.equal(summary.failed, 0); assert.equal(attempts[0].result, "sent");
});

test("Discord batch dispatch suppresses duplicate retailer SKU lifecycle causes", async () => {
  const attempts = [];
  let sends = 0;
  const duplicate = { ...marketSignal, id: "sig-duplicate" };
  const summary = await dispatchDiscordSignals([marketSignal, duplicate], {
    fetchImpl: async () => { sends += 1; return new Response(JSON.stringify({ id: `message-${sends}` }), { status: 200, headers: { "content-type": "application/json" } }); },
    enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async (attempt) => attempts.push(attempt),
  });
  assert.equal(sends, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(attempts.find((attempt) => attempt.result === "skipped")?.detail, "duplicate_batch_signal");
});

test("Discord dispatch records provider failure evidence", async () => {
  const attempts = [];
  const summary = await dispatchDiscordSignals([marketSignal], { fetchImpl: async () => new Response("provider unavailable", { status: 503 }), enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async (attempt) => attempts.push(attempt) });
  assert.equal(summary.sent, 0); assert.equal(summary.failed, 1); assert.match(attempts[0].detail, /503/);
});

test("telemetry failure never converts a successful Discord send into a delivery failure", async () => {
  const originalError = console.error; console.error = () => {};
  try {
    const summary = await dispatchDiscordSignals([marketSignal], { fetchImpl: async () => new Response(JSON.stringify({ id: "message-789" }), { status: 200, headers: { "content-type": "application/json" } }), enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async () => { throw new Error("telemetry unavailable"); } });
    assert.equal(summary.sent, 1); assert.equal(summary.failed, 0);
  } finally { console.error = originalError; }
});