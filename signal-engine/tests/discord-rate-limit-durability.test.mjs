import test from "node:test";
import assert from "node:assert/strict";
import { discordRateLimitWaitMs, dispatchDiscordSignals, sendDiscordSignal } from "../src/notifications/discord.mjs";

const whisper = {
  id: "sig-total-cards-burst",
  state: "whisper",
  kind: "catalogue_new",
  retailerId: "total-cards",
  retailerName: "Total Cards",
  retailerSku: "SKU-429",
  offerId: "off-429",
  productId: "prd-429",
  title: "Pokemon - Scarlet & Violet - Obsidian Flames - Sleeved Booster",
  url: "https://totalcards.example/obsidian-flames-sleeved-booster",
  pricePence: 399,
  rrpPence: null,
  postagePence: null,
  deliveredPricePence: null,
  markupPercent: null,
  confidence: 0.98,
  detectedAt: 1_787_722_092,
  stockStatus: "out_of_stock",
  reason: "New retailer SKU/catalogue activity observed before verified availability",
};

function rateLimited(retryAfter = 0.3) {
  return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: retryAfter, global: false }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

function delivered(id = "message-429") {
  return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
}

test("Discord retry delay honours provider retry_after with a small safety margin", () => {
  const response = rateLimited(0.631);
  assert.equal(discordRateLimitWaitMs(response, JSON.stringify({ retry_after: 0.631 })), 631);
});

test("a burst-tail lifecycle signal retries 429 in place and keeps the same canonical signal", async () => {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) return rateLimited(calls === 1 ? 0.3 : 0.42);
    return delivered("message-recovered");
  };

  const result = await sendDiscordSignal(whisper, {
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
    enabled: true,
    botToken: "test-token",
    channelId: "123456789",
  });

  assert.equal(result.sent, true);
  assert.equal(result.messageId, "message-recovered");
  assert.equal(result.rateLimitRetries, 2);
  assert.deepEqual(sleeps, [400, 520]);
  assert.equal(calls, 3);
});

test("successful in-place rate-limit recovery records one sent attempt rather than replacement lifecycle events", async () => {
  const attempts = [];
  let calls = 0;
  const summary = await dispatchDiscordSignals([whisper], {
    fetchImpl: async () => (++calls === 1 ? rateLimited(0.2) : delivered("message-same-event")),
    sleepImpl: async () => {},
    enabled: true,
    botToken: "test-token",
    channelId: "123456789",
    onDeliveryAttempt: async (attempt) => attempts.push(attempt),
  });

  assert.deepEqual({ sent: summary.sent, failed: summary.failed, skipped: summary.skipped }, { sent: 1, failed: 0, skipped: 0 });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].signalId, whisper.id);
  assert.equal(attempts[0].result, "sent");
  assert.match(attempts[0].detail, /rate_limit_retries:1/);
});

test("bounded Discord 429 retries still fail closed when provider never accepts the message", async () => {
  let calls = 0;
  await assert.rejects(
    sendDiscordSignal(whisper, {
      fetchImpl: async () => { calls += 1; return rateLimited(0); },
      sleepImpl: async () => {},
      maxRateLimitRetries: 2,
      rateLimitSafetyMs: 0,
      enabled: true,
      botToken: "test-token",
      channelId: "123456789",
    }),
    /Discord delivery failed \(429\)/,
  );
  assert.equal(calls, 3);
});
