import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHostedFateFinds, offerObservationTrust } from "../src/hosted/fatefind.mjs";

test("offer observation trust rejects stale and low-confidence stock evidence", () => {
  const now = 1787695100;
  assert.equal(offerObservationTrust({ lastSeenAt: now - 1800, stockConfidence: 0.98 }, { now }).eligible, true);
  assert.deepEqual(
    offerObservationTrust({ lastSeenAt: now - 1801, stockConfidence: 0.98 }, { now }).reason,
    "observation-stale",
  );
  assert.deepEqual(
    offerObservationTrust({ lastSeenAt: now - 60, stockConfidence: 0.55 }, { now }).reason,
    "stock-confidence-low",
  );
});

test("hosted FateFind uses fresh retailer and offer evidence and completes a real match insert", async () => {
  const calls = [];
  const find = {
    id: "find-1",
    user_id: "user-1",
    tcg_code: "pokemon",
    query_text: "Audit Elite Trainer Box",
    product_identity_id: "product-1",
    max_item_price_pence: 6000,
    max_true_price_pence: 6500,
    max_percent_above_rrp: 25,
    scope: "online",
    preferred_retailers_json: [],
    excluded_retailers_json: [],
    stock_requirement: "in_stock",
    notification_preferences_json: { website: true, app: false, discord: false },
  };
  const offer = {
    offer_id: "fresh-shop:sku-1",
    product_id: "product-1",
    retailer_id: "fresh-shop",
    retailer_name: "Fresh Shop",
    title: "Audit Elite Trainer Box",
    url: "https://example.com/fresh",
    price_pence: 5499,
    postage_pence: 0,
    stock_status: "in_stock",
    stock_confidence: 0.98,
    last_seen_at: 1787695000,
  };
  const product = {
    id: "product-1",
    tcg: "pokemon",
    title: "Audit Elite Trainer Box",
    official_rrp_pence: 4999,
  };

  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes("FROM fatedrop_fate_matches")) return { rows: [find] };
      if (text.includes("FROM fatedrop_retail_offers ro")) {
        assert.match(text, /JOIN fatedrop_retailer_health rh ON rh\.retailer_id=ro\.retailer_id/);
        assert.match(text, /rh\.healthy=true/);
        assert.match(text, /COALESCE\(rh\.last_success_at,rh\.last_scan_at\).*1800/s);
        assert.match(text, /ro\.last_seen_at.*1800/s);
        assert.match(text, /ro\.stock_confidence IS NULL OR ro\.stock_confidence >= 0\.9/s);
        return { rows: [offer] };
      }
      if (text.includes("FROM fatedrop_products")) return { rows: [product] };
      if (text.includes("INSERT INTO fatedrop_hosted_fate_matches")) {
        assert.equal(params[9], "Audit Elite Trainer Box", "persisted match title is defined from canonical product/offer evidence");
        return { rows: [{ inserted: true }] };
      }
      if (text.includes("FROM fatedrop_notification_preferences")) return { rows: [] };
      if (text.includes("INSERT INTO fatedrop_notification_outbox")) return { rows: [] };
      throw new Error(`Unexpected SQL in test: ${text}`);
    },
  };

  const result = await evaluateHostedFateFinds(pool, { now: 1787695100 });
  assert.deepEqual(result, { finds: 1, evaluated: 1, created: 1 });
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO fatedrop_notification_outbox")).length, 3);
});

test("defence-in-depth suppresses a stale offer even if a query source returns it", async () => {
  const now = 1787695100;
  const find = {
    id: "find-stale",
    user_id: "user-1",
    tcg_code: "pokemon",
    query_text: "Audit Elite Trainer Box",
    product_identity_id: "product-1",
    max_item_price_pence: null,
    max_true_price_pence: null,
    max_percent_above_rrp: null,
    scope: "online",
    preferred_retailers_json: [],
    excluded_retailers_json: [],
    stock_requirement: "in_stock",
    notification_preferences_json: {},
  };
  const staleOffer = {
    offer_id: "stale-shop:sku-1",
    product_id: "product-1",
    retailer_id: "stale-shop",
    retailer_name: "Stale Shop",
    title: "Audit Elite Trainer Box",
    url: "https://example.com/stale",
    price_pence: 3999,
    postage_pence: 0,
    stock_status: "in_stock",
    stock_confidence: 0.99,
    last_seen_at: now - 1801,
  };

  const pool = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("FROM fatedrop_fate_matches")) return { rows: [find] };
      if (text.includes("FROM fatedrop_retail_offers ro")) return { rows: [staleOffer] };
      if (text.includes("FROM fatedrop_products")) return { rows: [{ id: "product-1", tcg: "pokemon", title: "Audit Elite Trainer Box", official_rrp_pence: 4999 }] };
      if (text.includes("INSERT INTO fatedrop_hosted_fate_matches")) throw new Error("stale offer must never create a FateMatch");
      throw new Error(`Unexpected SQL in stale-offer test: ${text}`);
    },
  };

  const result = await evaluateHostedFateFinds(pool, { now });
  assert.deepEqual(result, { finds: 1, evaluated: 0, created: 0 });
});
