import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscordSignalMessage,
  companionForSignal,
  discordBotTokenForState,
  discordChannelForState,
  sendDiscordSignal,
} from "../src/notifications/discord.mjs";

const baseSignal = {
  id: "sig-routing",
  state: "manifested",
  kind: "availability_live",
  alertClass: "market_stock",
  retailerId: "test-retailer",
  retailerName: "Test Retailer",
  retailerSku: "SKU-1",
  offerId: "off-1",
  productId: "prd-1",
  title: "Test Elite Trainer Box",
  url: "https://example.com/product",
  imageUrl: null,
  pricePence: 4999,
  rrpPence: 4999,
  deliveredPricePence: 5299,
  markupPercent: 0,
  confidence: 0.99,
  detectedAt: 1_700_000_000,
  stockStatus: "in_stock",
  reason: "Availability became verified",
};

const expectedCompanions = {
  whisper: "Oru",
  echo: "Fenn",
  manifested: "Koru",
  vanished: "Nixon",
};

const botTokens = {
  whisper: "oru-token",
  echo: "fenn-token",
  manifested: "koru-token",
  vanished: "nixon-token",
};

test("each lifecycle state has one stable FateDrop companion", () => {
  for (const [state, companion] of Object.entries(expectedCompanions)) {
    assert.equal(companionForSignal(state), companion);
    const message = buildDiscordSignalMessage({ ...baseSignal, state });
    assert.match(message.embeds[0].title, new RegExp(`^${companion} · `));
    assert.match(message.embeds[0].footer.text, new RegExp(`^${companion} · FateDrop Signal`));
  }
});

test("lifecycle-specific Discord channels take precedence over fallback", () => {
  const channelIds = {
    whisper: "whisper-channel",
    echo: "echo-channel",
    manifested: "manifested-channel",
    vanished: "vanished-channel",
  };
  assert.equal(discordChannelForState("whisper", { channelIds, fallbackChannelId: "fallback" }), "whisper-channel");
  assert.equal(discordChannelForState("echo", { channelIds, fallbackChannelId: "fallback" }), "echo-channel");
  assert.equal(discordChannelForState("manifested", { channelIds, fallbackChannelId: "fallback" }), "manifested-channel");
  assert.equal(discordChannelForState("vanished", { channelIds, fallbackChannelId: "fallback" }), "vanished-channel");
});

test("lifecycle-specific bot tokens take precedence over the legacy fallback token", () => {
  for (const state of Object.keys(expectedCompanions)) {
    assert.equal(discordBotTokenForState(state, { botTokens, fallbackBotToken: "legacy-token" }), botTokens[state]);
  }
  assert.equal(discordBotTokenForState("echo", { botTokens: {}, fallbackBotToken: "legacy-token" }), "legacy-token");
});

test("missing lifecycle channel safely falls back to legacy premium channel", () => {
  assert.equal(discordChannelForState("echo", { channelIds: {}, fallbackChannelId: "fallback" }), "fallback");
});

test("Discord sends each signal with its companion bot to its lifecycle channel", async () => {
  const requests = [];
  const channelIds = {
    whisper: "111",
    echo: "222",
    manifested: "333",
    vanished: "444",
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization });
    return new Response(JSON.stringify({ id: `msg-${requests.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  for (const state of Object.keys(expectedCompanions)) {
    const result = await sendDiscordSignal({ ...baseSignal, state }, {
      fetchImpl,
      enabled: true,
      botTokens,
      fallbackBotToken: "legacy-token",
      channelIds,
      fallbackChannelId: "999",
    });
    assert.equal(result.sent, true);
    assert.equal(result.channelId, channelIds[state]);
    assert.equal(result.companion, expectedCompanions[state]);
  }

  assert.deepEqual(requests, [
    { url: "https://discord.com/api/v10/channels/111/messages", authorization: "Bot oru-token" },
    { url: "https://discord.com/api/v10/channels/222/messages", authorization: "Bot fenn-token" },
    { url: "https://discord.com/api/v10/channels/333/messages", authorization: "Bot koru-token" },
    { url: "https://discord.com/api/v10/channels/444/messages", authorization: "Bot nixon-token" },
  ]);
});
