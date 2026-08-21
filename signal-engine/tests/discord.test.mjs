import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordSignalMessage, dispatchDiscordSignals, isDiscordSignal, publicDiscordStage, sendDiscordSignal } from "../src/notifications/discord.mjs";

const signal = {
  id: "sig-test", state: "manifested", retailerName: "Test Retailer", title: "Test Booster Box",
  url: "https://example.com/product", imageUrl: null, pricePence: 4999, rrpPence: 4499,
  deliveredPricePence: null, markupPercent: 11.1135, confidence: 0.98, detectedAt: 1_700_000_000,
  stockStatus: "in_stock", reason: "Availability became verified",
};

test("Discord delivers all four FateDrop lifecycle signals", () => {
  for (const state of ["whisper","echo","manifested","vanished"]) assert.equal(isDiscordSignal({ ...signal, state }), true);
  assert.equal(isDiscordSignal({ ...signal, state: "unknown" }), false);
});

test("Discord exposes the final canonical public lifecycle vocabulary", () => {
  assert.equal(publicDiscordStage("whisper"), "Whisper");
  assert.equal(publicDiscordStage("echo"), "Echo");
  assert.equal(publicDiscordStage("manifested"), "Manifested");
  assert.equal(publicDiscordStage("vanished"), "Vanished");
  assert.equal(publicDiscordStage("unknown"), null);
});

test("Whisper is product/catalogue pre-event intelligence", () => {
  const message = buildDiscordSignalMessage({ ...signal, state: "whisper", stockStatus: "coming_soon", reason: null });
  assert.match(message.embeds[0].title, /WHISPER/);
  assert.match(message.embeds[0].description, /Product or catalogue movement/);
  assert.equal(message.components[0].components[0].label, "Inspect product");
});

test("Echo is traffic/security readiness intelligence", () => {
  const message = buildDiscordSignalMessage({ ...signal, state: "echo", reason: null });
  assert.match(message.embeds[0].title, /ECHO/);
  assert.match(message.embeds[0].description, /Traffic, queue or security/);
  assert.equal(message.components[0].components[0].label, "Get ready / inspect");
});

test("Manifested includes retailer, price, RRP and buy link", () => {
  const message = buildDiscordSignalMessage(signal);
  assert.match(message.embeds[0].title, /MANIFESTED/);
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Retailer")?.value, "Test Retailer");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Price")?.value, "£49.99");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Official RRP")?.value, "£44.99");
  assert.equal(message.components[0].components[0].label, "Buy / view product");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test("Vanished uses alternatives wording", () => {
  const message = buildDiscordSignalMessage({ ...signal, state: "vanished", stockStatus: "out_of_stock" });
  assert.match(message.embeds[0].title, /VANISHED/);
  assert.equal(message.components[0].components[0].label, "View product / alternatives");
});

test("Discord omits unavailable RRP intelligence instead of showing fake values", () => {
  const message = buildDiscordSignalMessage({ ...signal, rrpPence: null, markupPercent: null });
  assert.equal(message.embeds[0].fields.some((field) => field.name === "Official RRP"), false);
  assert.equal(message.embeds[0].fields.some((field) => field.name === "Vs RRP"), false);
});

test("Discord delivery posts to configured channel", async () => {
  let request = null;
  const fetchImpl = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ id: "message-123" }), { status: 200, headers: { "content-type": "application/json" } }); };
  const result = await sendDiscordSignal(signal, { fetchImpl, enabled: true, botToken: "test-token", channelId: "123456789" });
  assert.equal(result.sent, true);
  assert.equal(result.messageId, "message-123");
  assert.equal(request.url, "https://discord.com/api/v10/channels/123456789/messages");
  assert.equal(request.options.headers.Authorization, "Bot test-token");
});

test("Discord dispatch records successful provider delivery evidence", async () => {
  const attempts = [];
  const summary = await dispatchDiscordSignals([signal], { fetchImpl: async () => new Response(JSON.stringify({ id: "message-456" }), { status: 200, headers: { "content-type": "application/json" } }), enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async (attempt) => attempts.push(attempt) });
  assert.equal(summary.sent, 1); assert.equal(summary.failed, 0); assert.equal(attempts[0].result, "sent");
});

test("Discord dispatch records provider failure evidence", async () => {
  const attempts = [];
  const summary = await dispatchDiscordSignals([signal], { fetchImpl: async () => new Response("provider unavailable", { status: 503 }), enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async (attempt) => attempts.push(attempt) });
  assert.equal(summary.sent, 0); assert.equal(summary.failed, 1); assert.match(attempts[0].detail, /503/);
});

test("telemetry failure never converts a successful Discord send into a delivery failure", async () => {
  const originalError = console.error; console.error = () => {};
  try {
    const summary = await dispatchDiscordSignals([signal], { fetchImpl: async () => new Response(JSON.stringify({ id: "message-789" }), { status: 200, headers: { "content-type": "application/json" } }), enabled: true, botToken: "test-token", channelId: "123456789", onDeliveryAttempt: async () => { throw new Error("telemetry unavailable"); } });
    assert.equal(summary.sent, 1); assert.equal(summary.failed, 0);
  } finally { console.error = originalError; }
});
