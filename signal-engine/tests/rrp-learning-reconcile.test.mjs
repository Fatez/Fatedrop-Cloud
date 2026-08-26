import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRrpLearningQueue } from "../src/core/rrp-learning-reconcile.mjs";

test("reconciler promotes a unique verified official match into alias memory", async () => {
  const queries = [];
  const queue = {
    id: "q1", tcg: "pokemon", retailer_id: "magic-madhouse",
    observed_title: "SWSH Silver Tempest Booster Box", product_type: "booster_box",
    language_code: null, region_code: null,
  };
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT \*/.test(sql) && /rrp_resolution_queue/.test(sql)) return { rows: [queue] };
      if (/INSERT INTO fatedrop_product_identity_aliases/.test(sql)) return { rows: [{ id: "alias1" }] };
      if (/UPDATE fatedrop_rrp_resolution_queue/.test(sql)) return { rows: [] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ remaining: 0 }] };
      return { rows: [] };
    },
  };
  const store = {
    async pool() { return pool; },
    async listProducts() {
      return [{
        id: "prd-silver", title: "Pokémon TCG: Sword & Shield–Silver Tempest Booster Display Box (36 Packs)",
        productType: "booster_box", tcg: "pokemon", officialRrpPence: 13499,
        rrpSource: "pokemon-center-uk", rrpObservedAt: 123,
      }];
    },
  };
  const result = await reconcileRrpLearningQueue({ store, now: 200 });
  assert.equal(result.resolved, 1);
  assert.equal(result.remaining, 0);
  const aliasInsert = queries.find(({ sql }) => /INSERT INTO fatedrop_product_identity_aliases/.test(sql));
  assert.ok(aliasInsert);
  assert.equal(aliasInsert.params[5], "prd-silver");
  assert.equal(aliasInsert.params[7], 1);
});

test("reconciler never promotes component references into product aliases", async () => {
  const pool = {
    async query(sql) {
      if (/SELECT \*/.test(sql) && /rrp_resolution_queue/.test(sql)) return { rows: [{ id:"q2", tcg:"pokemon", retailer_id:"x", observed_title:"Destined Rivals 6 Packs Bundle", product_type:"other" }] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ remaining: 1 }] };
      if (/INSERT INTO fatedrop_product_identity_aliases/.test(sql)) throw new Error("must not learn component alias");
      return { rows: [] };
    },
  };
  const store = {
    async pool(){ return pool; },
    async listProducts(){ return [{ id:"pack", title:"Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack", productType:"booster_pack", tcg:"pokemon", officialRrpPence:429, rrpSource:"asmodee-uk", rrpObservedAt:123 }]; },
  };
  const result = await reconcileRrpLearningQueue({ store, now: 200 });
  assert.equal(result.resolved, 0);
  assert.equal(result.remaining, 1);
});

test("already-escalated rows on the same authority fingerprint are filtered before LIMIT", async () => {
  let selection = null;
  const pool = {
    async query(sql, params = []) {
      if (/SELECT \*/.test(sql) && /rrp_resolution_queue/.test(sql)) {
        selection = { sql, params };
        return { rows: [] };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ remaining: 2640 }] };
      return { rows: [] };
    },
  };
  const store = {
    async pool() { return pool; },
    async listProducts() {
      return [{
        id: "authority-1", title: "Pokemon TCG Example Booster Box", productType: "booster_box",
        officialRrpPence: 15199, rrpSource: "pokemon-center-uk", rrpObservedAt: 123,
      }];
    },
  };

  await reconcileRrpLearningQueue({ store, limit: 100, now: 300 });
  assert.ok(selection);
  assert.match(selection.sql, /COALESCE\(evidence_json->>'escalated','false'\)='true'/);
  assert.match(selection.sql, /authority_fingerprint/);
  assert.match(selection.sql, /reconciler_rules_version/);
  assert.equal(selection.params[0], 100);
  assert.match(selection.params[1], /^rrp-self-heal-v2:/);
  assert.equal(selection.params[2], "rrp-self-heal-v2");
});
