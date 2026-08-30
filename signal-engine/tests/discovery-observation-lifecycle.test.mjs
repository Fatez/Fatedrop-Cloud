import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRetailerDiscoveryObservations } from "../src/core/discovery-intake.mjs";
import { buildDiscordSignalMessage } from "../src/notifications/discord.mjs";
import { FileStore } from "../src/stores/file-store.mjs";

const NOW = 2_000_000;
const RETAILER = {
  id: "pokemon-center-uk",
  name: "Pokémon Center UK",
  tcg: "pokemon",
  officialRrpSource: true,
  baseUrl: "https://www.pokemoncenter.com/en-gb/",
  productUrlPattern: /pokemoncenter\.com\/en-gb\/product\//i,
  skuPattern: /\/product\/([^/?#]+)/i,
};

const page = (slug) => `https://www.pokemoncenter.com/en-gb/product/${slug}`;

function discovery(overrides = {}) {
  return {
    discoveryObservation: true,
    title: "Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)",
    url: page("30th-celebration-booster-bundle-6-packs"),
    pageExists: true,
    officialPageVerified: true,
    discoveredAt: NOW,
    evidenceSource: "poke_soak_watch",
    changeType: "new_product_page",
    confidence: 0.98,
    ...overrides,
  };
}

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "fatedrop-discovery-"));
  const store = new FileStore(join(dir, "state.json"));
  try { return await fn(store); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function ingest(store, observations, receivedAt = NOW) {
  return ingestRetailerDiscoveryObservations({
    retailer: RETAILER,
    store,
    observations,
    receivedAt,
    dispatchNotifications: false,
  });
}

function kind(signal, name) {
  return signal?.evidence?.find((entry) => entry.kind === name)?.value ?? null;
}

test("1. new verified official retailer page becomes one canonical Whisper", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery()]);
  assert.equal(result.signalsCreated, 1);
  assert.equal(result.signals[0].state, "whisper");
  assert.equal(result.signals[0].kind, "catalogue_new");
  assert.equal(kind(result.signals[0], "official_retailer_product_page"), page("30th-celebration-booster-bundle-6-packs"));
}));

test("2. rediscovering the same official page does not create a duplicate Whisper", async () => withStore(async (store) => {
  const first = await ingest(store, [discovery()]);
  const second = await ingest(store, [discovery({ discoveredAt: NOW + 120 })], NOW + 120);
  assert.equal(first.signalsCreated, 1);
  assert.equal(second.signalsCreated, 0);
  // The lifecycle derivation layer now suppresses unchanged repeats before the
  // persistence deduper sees them, so there is no duplicate signal to count.
  assert.equal(second.deduplicatedSignals, 0);
  const signals = await store.listSignals({ retailerIds: [RETAILER.id], since: 0, limit: 20 });
  assert.equal(signals.filter((signal) => signal.state === "whisper").length, 1);
}));

test("3. official page plus PREORDER text remains Whisper", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery({ preorderText: true, availabilityText: "PREORDER — estimated September 2026", pricePence: 2699 })]);
  assert.equal(result.signals[0].state, "whisper");
  assert.equal(result.signals[0].stockStatus, "preorder");
  assert.equal(kind(result.signals[0], "preorder_metadata"), "PREORDER — estimated September 2026");
}));

test("4. official page plus enabled preorder purchase control becomes Manifested", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery({ preorderText: true, preorderPurchaseEnabled: true, pricePence: 2699 })]);
  assert.equal(result.signalsCreated, 1);
  assert.equal(result.signals[0].state, "manifested");
  assert.equal(result.signals[0].stockStatus, "preorder");
  assert.equal(kind(result.signals[0], "purchase_path_verified"), "enabled_preorder_purchase_control");
}));

test("5. Whisper later becoming orderable creates exactly one Manifested transition", async () => withStore(async (store) => {
  const whisper = await ingest(store, [discovery()]);
  const manifested = await ingest(store, [discovery({ discoveredAt: NOW + 120, addToCartEnabled: true, pricePence: 2699, changeType: "purchase_control_enabled" })], NOW + 120);
  const repeated = await ingest(store, [discovery({ discoveredAt: NOW + 180, addToCartEnabled: true, pricePence: 2699, changeType: "purchase_control_enabled" })], NOW + 180);
  assert.equal(whisper.signals[0].state, "whisper");
  assert.equal(manifested.signals[0].state, "manifested");
  assert.equal(repeated.signalsCreated, 0);
  const signals = await store.listSignals({ retailerIds: [RETAILER.id], since: 0, limit: 20 });
  assert.deepEqual(signals.map((signal) => signal.state).sort(), ["manifested", "whisper"]);
}));

test("6. malformed retailer URL is preserved as evidence but never exposed as a fake link", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery({ url: "https://www.pokemoncenter.com/-" })]);
  assert.equal(result.signalsCreated, 1);
  assert.equal(result.signals[0].state, "whisper");
  assert.equal(result.signals[0].url, "");
  assert.equal(kind(result.signals[0], "discovery_url_status"), "invalid_or_missing");
  const message = buildDiscordSignalMessage(result.signals[0]);
  assert.equal(message.components, undefined);
  assert.equal(message.embeds[0].url, undefined);
}));

test("7. 30th Anniversary discovery carries high-priority metadata without changing lifecycle truth", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery()]);
  assert.equal(result.signals[0].state, "whisper");
  assert.equal(kind(result.signals[0], "discovery_priority"), "high");
  assert.equal(kind(result.signals[0], "discovery_priority_reason"), "anniversary");
}));

test("8. the persisted ledger and Discord consume the same canonical event ID", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery()]);
  const [persisted] = await store.listSignals({ retailerIds: [RETAILER.id], since: 0, limit: 5 });
  const message = buildDiscordSignalMessage(result.signals[0]);
  assert.equal(result.signals.length, 1);
  assert.equal(persisted.id, result.signals[0].id);
  assert.match(message.embeds[0].footer.text, new RegExp(result.signals[0].id));
}));

test("9. a previously Manifested product losing verified availability becomes Vanished", async () => withStore(async (store) => {
  const live = await ingest(store, [discovery({ addToCartEnabled: true, pricePence: 2699 })]);
  const gone = await ingest(store, [discovery({ discoveredAt: NOW + 120, pageExists: false, officialPageVerified: false, changeType: "page_or_availability_removed" })], NOW + 120);
  assert.equal(live.signals[0].state, "manifested");
  assert.equal(gone.signalsCreated, 1);
  assert.equal(gone.signals[0].state, "vanished");
}));

test("10. collector lifecycle or in-stock claims cannot directly declare Manifested", async () => withStore(async (store) => {
  const result = await ingest(store, [discovery({ state: "manifested", lifecycle: "manifested", stockStatus: "in_stock", pricePence: 2699 })]);
  assert.equal(result.signalsCreated, 1);
  assert.equal(result.signals[0].state, "whisper");
  assert.equal(result.signals[0].stockStatus, "coming_soon");
}));

test("discovery observation persistence never rewrites full-catalogue retailer health", async () => withStore(async (store) => {
  await store.mutate((state) => {
    state.retailers ||= {};
    state.metadata ||= { baselineCompleted: {} };
    state.metadata.baselineCompleted ||= {};
    state.retailers[RETAILER.id] = { id: RETAILER.id, name: RETAILER.name, healthy: false, lastScanAt: 1234, lastSuccessAt: 1200, productsSeen: 976, pagesScanned: 40 };
    state.metadata.baselineCompleted[RETAILER.id] = true;
  });
  await ingest(store, [discovery()]);
  const [health] = (await store.listRetailers()).filter((item) => item.id === RETAILER.id);
  assert.equal(health.lastScanAt, 1234);
  assert.equal(health.productsSeen, 976);
  assert.equal(health.healthy, false);
}));

test("historical discoveries strengthen stored evidence without generating user-facing lifecycle alerts", async () => withStore(async (store) => {
  const staleAt = NOW - (60 * 60);
  const result = await ingest(store, [discovery({ discoveredAt: staleAt })], NOW);
  assert.equal(result.signalsCreated, 0);
  const offers = await store.listOffers({ limit: 5 });
  assert.equal(offers.length, 1);
  const signals = await store.listSignals({ retailerIds: [RETAILER.id], since: 0, limit: 5 });
  assert.equal(signals.length, 0);
}));
