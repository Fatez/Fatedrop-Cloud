import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildFateFindEvaluatorPreflight } from "../src/telemetry/fatefind-evaluator-preflight.mjs";

function findRow(overrides = {}) {
  return {
    id: "find-secret-id",
    user_id: "user-secret-id",
    tcg_code: "pokemon",
    query_text: "Destined Rivals ETB",
    product_identity_id: null,
    max_item_price_pence: null,
    max_true_price_pence: 8000,
    max_percent_above_rrp: null,
    scope: "either",
    preferred_retailers_json: [],
    excluded_retailers_json: [],
    stock_requirement: "in_stock",
    total_eligible: 1,
    ...overrides,
  };
}

function offerRow(overrides = {}) {
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
    total_available: 1,
    ...overrides,
  };
}

function storeFor({ find = findRow(), offer = offerRow(), productTitle = "Pokemon Destined Rivals Elite Trainer Box" } = {}) {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM fatedrop_fate_matches")) return { rows: find ? [find] : [] };
      if (sql.includes("FROM fatedrop_retail_offers")) return { rows: offer ? [offer] : [] };
      if (sql.includes("FROM fatedrop_products")) return { rows: [{ id: "product-secret-id", tcg: "pokemon", title: productTitle, official_rrp_pence: 5499 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return { store: { async pool() { return pool; } }, calls };
}

const serverSource = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

test("FateFind evaluator preflight uses the production matcher but performs no writes", async () => {
  const { store, calls } = storeFor();
  const result = await buildFateFindEvaluatorPreflight(store, { now: 2000, maxFinds: 20, maxOffers: 100 });
  assert.equal(result.available, true);
  assert.equal(result.eligibleFinds, 1);
  assert.equal(result.purchasableOffers, 1);
  assert.equal(result.evaluated, 1);
  assert.equal(result.wouldMatch, 1);
  assert.equal(result.findsWithMatch, 1);
  assert.equal(result.complete, true);
  assert.ok(calls.every((sql) => /^\s*SELECT/i.test(sql)));
  const publicSnapshot = JSON.stringify(result);
  assert.equal(publicSnapshot.includes("user-secret-id"), false);
  assert.equal(publicSnapshot.includes("find-secret-id"), false);
  assert.equal(publicSnapshot.includes("offer-secret-id"), false);
});

test("FateFind evaluator preflight reports why the current offer does not match without creating a FateMatch", async () => {
  const { store } = storeFor({
    offer: offerRow({ title: "Pokemon Destined Rivals Booster Pack", price_pence: 899, postage_pence: 295 }),
    productTitle: "Pokemon Destined Rivals Booster Pack",
  });
  const result = await buildFateFindEvaluatorPreflight(store, { now: 2000, maxFinds: 20, maxOffers: 100 });
  assert.equal(result.wouldMatch, 0);
  assert.equal(result.findsWithMatch, 0);
  assert.deepEqual(result.topRejectionReasons, [{ reason: "query-mismatch", count: 1 }]);
});

test("preflight makes bounded sampling explicit instead of claiming full coverage", async () => {
  const { store } = storeFor({
    find: findRow({ total_eligible: 4 }),
    offer: offerRow({ total_available: 15000 }),
  });
  const result = await buildFateFindEvaluatorPreflight(store, { now: 2000, maxFinds: 1, maxOffers: 10000 });
  assert.equal(result.findsTruncated, true);
  assert.equal(result.offersTruncated, true);
  assert.equal(result.complete, false);
});

test("Signal Engine exposes the evaluator preflight as a read-only operations endpoint", () => {
  assert.match(serverSource, /\/api\/fatefind-evaluator-preflight/);
  assert.match(serverSource, /buildFateFindEvaluatorPreflight\(store\)/);
  assert.doesNotMatch(serverSource, /fatefind-evaluator-preflight[\s\S]{0,350}INSERT INTO/);
});
