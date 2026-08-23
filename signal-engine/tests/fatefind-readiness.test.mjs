import test from "node:test";
import assert from "node:assert/strict";

process.env.FATEDROP_SIGNAL_STORE = "postgres";
const { buildHostedFateFindReadiness } = await import("../src/telemetry/fatefind-readiness.mjs");

function findRow(overrides = {}) {
  return {
    id: "find-secret-id",
    user_id: "user-secret-id",
    query_text: "Destined Rivals ETB",
    product_identity_id: null,
    max_item_price_pence: null,
    max_true_price_pence: 8000,
    max_percent_above_rrp: null,
    scope: "either",
    preferred_retailers_json: [],
    excluded_retailers_json: [],
    stock_requirement: "in_stock",
    notification_preferences_json: { app: true, discord: true, website: true },
    total_eligible: 1,
    ...overrides,
  };
}

function offerRow() {
  return {
    offer_id: "offer-secret-id",
    product_id: "product-secret-id",
    retailer_id: "retailer-a",
    retailer_name: "Retailer A",
    title: "Pokemon Destined Rivals Elite Trainer Box",
    url: "https://example.test/product",
    price_pence: 7000,
    postage_pence: 0,
    stock_status: "in_stock",
    last_seen_at: 1000,
    total_available: 1,
  };
}

function makeStore({ prefs = [], push = [], discord = [], outbox = {} } = {}) {
  const pool = {
    async query(sql) {
      if (sql.includes("FROM fatedrop_fate_matches")) return { rows: [findRow()] };
      if (sql.includes("FROM fatedrop_retail_offers")) return { rows: [offerRow()] };
      if (sql.includes("FROM fatedrop_products")) return { rows: [{ id: "product-secret-id", title: "Pokemon Destined Rivals Elite Trainer Box", official_rrp_pence: 4999 }] };
      if (sql.includes("FROM fatedrop_notification_preferences")) return { rows: prefs };
      if (sql.includes("FROM fatedrop_push_endpoints")) return { rows: push };
      if (sql.includes("FROM fatedrop_discord_links")) return { rows: discord };
      if (sql.includes("FROM fatedrop_notification_outbox")) return { rows: [{ total: 0, sent: 0, suppressed: 0, pending: 0, failed: 0, sending: 0, overdue: 0, stuck_sending: 0, ...outbox }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { async pool() { return pool; } };
}

test("FateFind preflight proves evaluator and requested delivery coverage without writing", async () => {
  const store = makeStore({
    prefs: [{ user_id: "user-secret-id", fate_match_enabled: true, web_enabled: true, push_enabled: true, discord_enabled: true, quiet_hours_enabled: false }],
    push: [{ user_id: "user-secret-id", enabled_count: 1 }],
    discord: [{ user_id: "user-secret-id", linked_count: 1 }],
  });
  const result = await buildHostedFateFindReadiness(store, { now: 2000, maxFinds: 20, maxOffers: 100 });
  assert.equal(result.available, true);
  assert.equal(result.storeReady, true);
  assert.equal(result.eligibleFinds, 1);
  assert.equal(result.purchasableOffers, 1);
  assert.equal(result.evaluated, 1);
  assert.equal(result.wouldMatch, 1);
  assert.equal(result.findsWithMatch, 1);
  assert.equal(result.delivery.webReadyFinds, 1);
  assert.equal(result.delivery.pushReadyFinds, 1);
  assert.equal(result.delivery.discordReadyFinds, 1);
  assert.equal(result.queue.ready, true);
  assert.equal(result.evaluatorReady, true);
  assert.equal(result.betaDeliveryReady, true);
  assert.deepEqual(result.blockers, []);
  const publicSnapshot = JSON.stringify(result);
  assert.equal(publicSnapshot.includes("user-secret-id"), false);
  assert.equal(publicSnapshot.includes("find-secret-id"), false);
  assert.equal(publicSnapshot.includes("offer-secret-id"), false);
});

test("FateFind preflight exposes missing physical push and Discord readiness instead of pretending delivery works", async () => {
  const result = await buildHostedFateFindReadiness(makeStore(), { now: 2000, maxFinds: 20, maxOffers: 100 });
  assert.equal(result.evaluatorReady, true);
  assert.equal(result.delivery.webReadyFinds, 1);
  assert.equal(result.delivery.pushRequestedFinds, 1);
  assert.equal(result.delivery.pushReadyFinds, 0);
  assert.equal(result.delivery.pushMissingEndpointFinds, 1);
  assert.equal(result.delivery.discordRequestedFinds, 1);
  assert.equal(result.delivery.discordReadyFinds, 0);
  assert.equal(result.delivery.discordPreferenceDisabledFinds, 1);
  assert.equal(result.betaDeliveryReady, false);
  assert.ok(result.blockers.includes("requested_push_delivery_not_registered"));
  assert.ok(result.blockers.includes("requested_discord_delivery_not_ready"));
});

test("FateFind preflight fails closed when the notification outbox is unhealthy", async () => {
  const store = makeStore({
    prefs: [{ user_id: "user-secret-id", fate_match_enabled: true, web_enabled: true, push_enabled: true, discord_enabled: true }],
    push: [{ user_id: "user-secret-id", enabled_count: 1 }],
    discord: [{ user_id: "user-secret-id", linked_count: 1 }],
    outbox: { total: 1, pending: 1, overdue: 1 },
  });
  const result = await buildHostedFateFindReadiness(store, { now: 2000, maxFinds: 20, maxOffers: 100 });
  assert.equal(result.queue.ready, false);
  assert.equal(result.evaluatorReady, false);
  assert.ok(result.blockers.includes("fate_match_outbox_not_ready"));
});
