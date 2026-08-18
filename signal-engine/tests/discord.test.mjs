import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordSignalMessage, isDiscordSignal, sendDiscordSignal } from "../src/notifications/discord.mjs";

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
  reason: "Availability became verified",
};

test("Discord only delivers Manifested and Echo signals", () => {
  assert.equal(isDiscordSignal(signal), true);
  assert.equal(isDiscordSignal({ ...signal, state: "echo" }), true);
  assert.equal(isDiscordSignal({ ...signal, state: "whisper" }), false);
  assert.equal(isDiscordSignal({ ...signal, state: "vanished" }), false);
});

test("Discord message includes retailer, price and retailer link", () => {
  const message = buildDiscordSignalMessage(signal);
  assert.equal(message.embeds.length, 1);
  assert.match(message.embeds[0].title, /MANIFESTED/);
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Retailer")?.value, "Test Retailer");
  assert.equal(message.embeds[0].fields.find((field) => field.name === "Price")?.value, "£49.99");
  assert.equal(message.components[0].components[0].url, "https://example.com/product");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
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
