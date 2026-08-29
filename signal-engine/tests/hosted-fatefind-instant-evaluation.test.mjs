import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHostedFateFinds } from "../src/hosted/fatefind.mjs";

test("instant hosted FateFind evaluation targets only the saved paid watch and reuses canonical match persistence", async () => {
  const now = 1787964000;
  const calls = [];
  const find = {
    id: "find-instant-1",
    user_id: "user-1",
    query_text: "Destined Rivals 3 Pack Blister Kangaskhan",
    product_identity_id: "product-1",
    max_item_price_pence: 4000,
    max_true_price_pence: null,
    max_percent_above_rrp: 10,
    scope: "online",
    preferred_retailers_json: [],
    excluded_retailers_json: [],
    stock_requirement: "in_stock",
    notification_preferences_json: { website: true, app: true, discord: false },
  };
  const offer = {
    offer_id: "magic-madhouse:sku-1",
    product_id: "product-1",
    retailer_id: "magic-madhouse",
    retailer_name: "Magic Madhouse",
    title: "Pokemon - Scarlet & Violet - Destined Rivals - 3 Pack Blister - Kangaskhan",
    url: "https://example.com/kangaskhan",
    price_pence: 3395,
    postage_pence: null,
    stock_status: "in_stock",
    stock_confidence: 0.99,
    last_seen_at: now - 60,
  };
  const product = {
    id: "product-1",
    title: "Pokemon - Scarlet & Violet - Destined Rivals - 3 Pack Blister - Kangaskhan",
    official_rrp_pence: 3499,
  };

  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes("FROM fatedrop_fate_matches")) {
        assert.match(text, /f\.id=\$1/);
        assert.match(text, /m\.tier IN \('plus','pro'\)/);
        assert.deepEqual(params, ["find-instant-1"]);
        return { rows: [find] };
      }
      if (text.includes("FROM fatedrop_retail_offers ro")) return { rows: [offer] };
      if (text.includes("FROM fatedrop_products")) return { rows: [product] };
      if (text.includes("INSERT INTO fatedrop_hosted_fate_matches")) return { rows: [{ inserted: true }] };
      if (text.includes("FROM fatedrop_notification_preferences")) return { rows: [] };
      if (text.includes("INSERT INTO fatedrop_notification_outbox")) return { rows: [] };
      throw new Error(`Unexpected SQL in instant FateFind test: ${text}`);
    },
  };

  const result = await evaluateHostedFateFinds(pool, { fateFindId: "find-instant-1", limit: 999, now });
  assert.deepEqual(result, { finds: 1, evaluated: 1, created: 1 });
  assert.equal(calls.filter((call) => call.text.includes("FROM fatedrop_fate_matches")).length, 1);
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO fatedrop_notification_outbox")).length, 3);
});

test("instant hosted FateFind evaluation fails closed when the requested watch is not active and paid", async () => {
  let offerRead = false;
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes("FROM fatedrop_fate_matches")) {
        assert.deepEqual(params, ["find-not-eligible"]);
        return { rows: [] };
      }
      if (text.includes("FROM fatedrop_retail_offers")) offerRead = true;
      throw new Error(`Unexpected SQL in ineligible instant FateFind test: ${text}`);
    },
  };

  const result = await evaluateHostedFateFinds(pool, { fateFindId: "find-not-eligible" });
  assert.deepEqual(result, { finds: 0, evaluated: 0, created: 0 });
  assert.equal(offerRead, false, "offers must not be scanned when the requested watch is ineligible");
});
