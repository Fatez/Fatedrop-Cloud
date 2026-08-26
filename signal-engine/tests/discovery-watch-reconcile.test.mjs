import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCT_DISCOVERY_WATCH_SOURCE, discoveryWatchRowToObservation, reconcileProductDiscoveryWatch } from "../src/core/discovery-watch-reconcile.mjs";

const NOW = 2_000_000;
const retailer = { id: "pokemon-center-uk", name: "Pokémon Center UK" };

function evidenceRow(overrides = {}) {
  return {
    evidence_id: "watch-1",
    retailer_id: retailer.id,
    source_type: PRODUCT_DISCOVERY_WATCH_SOURCE,
    source_url: "https://www.pokemoncenter.com/en-gb/product/30th-celebration-booster-bundle-6-packs",
    observed_at: NOW,
    evidence: {
      title: "Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)",
      pageExists: true,
      officialPageVerified: true,
      evidenceSource: "pokemon_uk_drop_watch",
      changeType: "new_official_product_page",
      confidence: 0.98,
      fingerprint: "official-page|not-orderable",
      canonical_pipeline: { status: "pending", attempts: 0 },
    },
    ...overrides,
  };
}

function fakeStore(rows) {
  const updates = [];
  const client = {
    async query(sql, params = []) {
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (String(sql).includes("FROM fatedrop_retailer_discovery_evidence")) return { rows };
      if (String(sql).includes("UPDATE fatedrop_retailer_discovery_evidence")) {
        updates.push({ evidenceId: params[0], pipeline: JSON.parse(params[1]) });
        return { rows: [] };
      }
      if (String(sql).includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return {
    updates,
    store: { pool: async () => ({ connect: async () => client }) },
  };
}

test("Drop Watch row becomes raw discovery evidence and cannot self-declare lifecycle", () => {
  const observation = discoveryWatchRowToObservation(evidenceRow({ evidence: {
    ...evidenceRow().evidence,
    lifecycle: "manifested",
    state: "manifested",
    stockStatus: "in_stock",
  } }));
  assert.equal(observation.discoveryObservation, true);
  assert.equal(observation.officialPageVerified, true);
  assert.equal(observation.evidenceSource, "pokemon_uk_drop_watch");
  assert.equal(observation.addToCartEnabled, false);
  assert.equal(observation.orderable, false);
  assert.equal(observation.lifecycle, undefined);
  assert.equal(observation.state, undefined);
});

test("pending Drop Watch evidence is consumed by the canonical discovery intake and marked processed", async () => {
  const harness = fakeStore([evidenceRow()]);
  const calls = [];
  const result = await reconcileProductDiscoveryWatch({
    store: harness.store,
    retailers: [retailer],
    now: NOW + 5,
    ingestFn: async (payload) => {
      calls.push(payload);
      return {
        signalsCreated: 1,
        deduplicatedSignals: 0,
        signals: [{ id: "sig-canonical-echo", state: "echo" }],
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].retailer.id, retailer.id);
  assert.equal(calls[0].observations[0].officialPageVerified, true);
  assert.equal(calls[0].dispatchNotifications, true);
  assert.equal(result.signalsCreated, 1);
  assert.deepEqual(result.signalIds, ["sig-canonical-echo"]);
  assert.equal(harness.updates[0].pipeline.status, "processed");
  assert.deepEqual(harness.updates[0].pipeline.signalIds, ["sig-canonical-echo"]);
});

test("canonical dedup result is preserved without manufacturing a second Echo", async () => {
  const harness = fakeStore([evidenceRow()]);
  const result = await reconcileProductDiscoveryWatch({
    store: harness.store,
    retailers: [retailer],
    now: NOW + 5,
    ingestFn: async () => ({ signalsCreated: 0, deduplicatedSignals: 1, signals: [] }),
  });
  assert.equal(result.signalsCreated, 0);
  assert.equal(result.deduplicatedSignals, 1);
  assert.equal(harness.updates[0].pipeline.status, "processed");
  assert.equal(harness.updates[0].pipeline.signalsCreated, 0);
  assert.equal(harness.updates[0].pipeline.deduplicatedSignals, 1);
});

test("unknown retailer evidence fails closed and never reaches lifecycle classification", async () => {
  const harness = fakeStore([evidenceRow({ retailer_id: "unknown-retailer" })]);
  let called = false;
  const result = await reconcileProductDiscoveryWatch({
    store: harness.store,
    retailers: [retailer],
    ingestFn: async () => { called = true; return {}; },
  });
  assert.equal(called, false);
  assert.equal(result.failed, 1);
  assert.equal(harness.updates[0].pipeline.status, "failed");
  assert.equal(harness.updates[0].pipeline.reason, "unknown_or_disabled_retailer");
});

test("transient intake failures are bounded and left retryable before terminal failure", async () => {
  const harness = fakeStore([evidenceRow()]);
  const result = await reconcileProductDiscoveryWatch({
    store: harness.store,
    retailers: [retailer],
    ingestFn: async () => { throw new Error("temporary canonical intake failure"); },
  });
  assert.equal(result.retried, 1);
  assert.equal(result.failed, 0);
  assert.equal(harness.updates[0].pipeline.status, "retry");
  assert.match(harness.updates[0].pipeline.reason, /temporary canonical intake failure/);
});
