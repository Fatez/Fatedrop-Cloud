import test from "node:test";
import assert from "node:assert/strict";
import { recordRetailerReadiness } from "../src/core/network-readiness.mjs";

const retailer = { id: "pokemon-center-uk", name: "Pokémon Center UK" };

function whisper(overrides = {}) {
  return {
    id: "sig-whisper-1",
    state: "whisper",
    kind: "catalogue_new",
    alertClass: "primary_drop",
    productId: "prd-1",
    offerId: "off-1",
    retailerId: retailer.id,
    retailerName: retailer.name,
    title: "Example Elite Trainer Box",
    productType: "elite_trainer_box",
    url: "https://example.test/product",
    imageUrl: null,
    pricePence: 4999,
    rrpPence: 4999,
    postagePence: null,
    deliveredPricePence: null,
    markupPercent: 0,
    stockStatus: "coming_soon",
    previousStockStatus: "out_of_stock",
    confidence: 0.7,
    detectedAt: 1000,
    reason: "Catalogue movement",
    evidence: [{ kind: "signal_kind", value: "catalogue_new", lifecycle: "whisper", observedAt: 1000 }],
    ...overrides,
  };
}

function storeWith(signals) {
  const appended = [];
  const events = [];
  return {
    appended,
    events,
    async listSignals({ states, retailerIds, since }) {
      return signals.filter((signal) => states.includes(signal.state) && retailerIds.includes(signal.retailerId) && signal.detectedAt >= since);
    },
    async appendSignals(next) { appended.push(...next); },
    async appendSignalEvent(event) { events.push(event); },
  };
}

test("queue readiness emits Echo onto recent real product context for a primary retailer", async () => {
  const store = storeWith([whisper({ detectedAt: 1900 })]);
  const result = await recordRetailerReadiness({ retailer, store, state: "queue", previousState: "normal", observedAt: 2000 });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "echo_emitted");
  assert.equal(result.productContexts, 1);
  assert.equal(result.readinessEvent.recorded, true);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].kind, "retailer_readiness");
  assert.equal(store.events[0].evidence.readinessState, "queue");
  assert.equal(store.events[0].evidence.retailer.id, retailer.id);
  assert.equal(store.appended.length, 1);
  assert.equal(store.appended[0].state, "echo");
  assert.equal(store.appended[0].kind, "queue");
  assert.equal(store.appended[0].alertClass, "primary_drop");
  assert.equal(store.appended[0].productId, "prd-1");
  assert.equal(store.appended[0].offerId, "off-1");
  assert.match(store.appended[0].reason, /queue \/ traffic-control/);
  assert.equal(store.appended[0].target.type, "product");
  assert.equal(store.appended[0].evidence.find((entry) => entry.kind === "signal_kind")?.value, "queue");
  assert.equal(store.appended[0].evidence.find((entry) => entry.kind === "retailer_readiness")?.readinessEventId, store.events[0].id);
});

test("market retailer readiness never emits public Echo noise", async () => {
  const marketRetailer = { id: "titan-cards", name: "Titan Cards" };
  const store = storeWith([whisper({ retailerId: marketRetailer.id, retailerName: marketRetailer.name, detectedAt: 1900 })]);
  const result = await recordRetailerReadiness({ retailer: marketRetailer, store, state: "security", previousState: "normal", observedAt: 2000 });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "market_retailer_readiness_suppressed");
  assert.equal(result.productContexts, 0);
  assert.deepEqual(store.appended, []);
  assert.deepEqual(store.events, []);
});

test("security readiness persists evidence without inventing a public Echo when product context is absent", async () => {
  const store = storeWith([]);
  const result = await recordRetailerReadiness({
    retailer,
    store,
    state: "security",
    previousState: "normal",
    observedAt: 2000,
    evidence: [{ kind: "browser_state", value: "security" }],
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "no_recent_retailer_product_context");
  assert.equal(result.productContexts, 0);
  assert.equal(result.readinessEvent.recorded, true);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].evidence.readinessState, "security");
  assert.deepEqual(store.appended, []);
});

test("normal browser state is not an Echo", async () => {
  const store = storeWith([whisper({ detectedAt: 1900 })]);
  const result = await recordRetailerReadiness({ retailer, store, state: "normal", previousState: "queue", observedAt: 2000 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "not_echo_state");
  assert.deepEqual(store.appended, []);
  assert.deepEqual(store.events, []);
});

test("readiness fan-out deduplicates multiple lifecycle signals for the same product", async () => {
  const store = storeWith([
    whisper({ id: "sig-a", detectedAt: 1950 }),
    whisper({ id: "sig-b", detectedAt: 1940 }),
  ]);
  const result = await recordRetailerReadiness({ retailer, store, state: "security", previousState: "normal", observedAt: 2000 });
  assert.equal(result.productContexts, 1);
  assert.equal(store.events.length, 1);
  assert.equal(store.appended.length, 1);
});

test("retailer product context older than seven days cannot receive Echo but readiness remains durable", async () => {
  const observedAt = 700000;
  const store = storeWith([whisper({ detectedAt: 1 })]);
  const result = await recordRetailerReadiness({ retailer, store, state: "queue", previousState: "normal", observedAt });
  assert.equal(result.productContexts, 0);
  assert.equal(result.reason, "no_recent_retailer_product_context");
  assert.equal(result.readinessEvent.recorded, true);
  assert.equal(store.events.length, 1);
  assert.deepEqual(store.appended, []);
});
