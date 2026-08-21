import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordSignalMessage, isDiscordSignal, publicDiscordStage, sendDiscordSignal } from "../src/notifications/discord.mjs";

const signal = {
  id: "sig-test",
  state: "manifested",
  retailerName: "Test Retailer",
  title: "Test Booster Box",
  url: "https://example.com/product",
  imageUrl: null,
  pricePence: 4999,
  rrpPence: 4499,
  deliveredPricePence: null,
  markupPercent: 11.1135,
  confidence: 0.98,
  detectedAt: 1_700_000_000,
  stockStatus: "in_stock",
  reason: "Availability became verified",
};

test("Discord delivers all internal FateDrop lifecycle signals", () => {
  assert.equal(isDiscordSignal(signal), true);
  assert.equal(isDiscordSignal({ ...signal, state: "echo" }), true);
  assert.equal(isDiscordSignal({ ...signal, state: "whisper" }), true);
  assert.equal(isDiscordSignal({ ...signal, state: "vanished" }), true);
  assert.equal(isDiscordSignal({ ...signal, state: "unknown" }), false);
});

test("Discord exposes canonical public lifecycle vocabulary", () => {
  assert.equal(publicDiscordStage("whisper"), "Echo");
  assert.equal(publicDiscordStage("manifested"), "Manifested");
  assert.equal(publicDiscordStage("echo"), "Manifested");
  assert.equal(publicDiscordStage("vanished"), "Vanished");
  assert.equal(publicDiscordStage("unknown"), null);
});

test("Discord manifested message includes retailer, price, RRP and retailer link", () => {
  const message = buildDiscordSignalMessage(signal);
  assert.equal(message.embeds.length, 1);
  assert.match(message.embeds[0].title, /MANIFESTED/);
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Retailer")?.value, "Test Retailer");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Price")?.value, "£49.99");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Official RRP")?.value, "£44.99");
  assert.equal(message.components[0].components[0].label, "Buy / view product");
  assert.equal(message.components[0].components[0].url, "https://example.com/product");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test("internal whisper is public Echo and never gets buy wording", () => {
  const message = buildDiscordSignalMessage({ ...signal, state: "whisper", stockStatus: "coming_soon" });
  assert.match(message.embeds[0].title, /ECHO/);
  assert.equal(message.components[0].components[0].label, "Inspect product");
});

test("internal restock echo is public Manifested", () => {
  const message = buildDiscordSignalMessage({ ...signal, state: "echo" });
  assert.match(message.embeds[0].title, /MANIFESTED/);
  assert.equal(message.components[0].components[0].label, "Buy / view product");
});

test("vanished uses non-purchase wording", () => {
  const message = buildDiscordSignalMessage({ ...signal, state: "vanished", stockStatus: "out_of_stock" });
  assert.match(message.embeds[0].title, /VANISHED/);
  assert.equal(message.components[0].components[0].label, "View last product page");
});

test("Discord omits unavailable RRP intelligence instead of showing fake values", () => {
  const message = buildDiscordSignalMessage({ ...signal, rrpPence: null, markupPercent: null });
  assert.equal(message.embeds[0].fields.some((field) => field.name === "Official RRP"), false);
  assert.equal(message.embeds[0].fields.some((field) => field.name === "Vs RRP"), false);
});

test("Discord delivery posts to configured channel", async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: "message-123" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await sendDiscordSignal(signal, {
    fetchImpl,
    enabled: true,
    botToken: "test-token",
    channelId: "123456789",
  });
  assert.equal(result.sent, true);
  assert.equal(result.messageId, "message-123");
  assert.equal(request.url, "https://discord.com/api/v10/channels/123456789/messages");
  assert.equal(request.options.headers.Authorization, "Bot test-token");
});
