import assert from "node:assert/strict";
import test from "node:test";

import {
  persistCanonicalMarketActions,
  preloadCanonicalMarketMemory,
  resolveCanonicalMarketIdentity,
} from "../src/stores/market-memory-store.mjs";

test("market memory preloads identities, aliases and verified identifiers in three batch queries", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM fatedrop_product_identities")) return { rows: [{ product_identity_id: "prd_current", canonical_key: "abyss-eye-booster-box", market_code: "JP", market_status: "verified" }] };
      if (sql.includes("FROM fatedrop_product_identity_aliases")) return { rows: [{ alias_signature: "pokemon|booster box|abyss eye booster box", product_type: "booster_box", product_identity_id: "prd_alias", market_code: "KR", market_status: "verified" }] };
      return { rows: [{ identifier_value: "1234567890123", product_identity_id: "prd_gtin", market_code: "CN", market_status: "verified" }] };
    },
  };
  const prepared = [{
    productId: "prd_current",
    raw: { title: "Abyss Eye Booster Box", canonicalKey: "abyss-eye-booster-box", productType: "booster_box", gtin: "1234567890123" },
  }];
  const context = await preloadCanonicalMarketMemory({ store: { pool: async () => pool }, prepared, tcg: "pokemon" });
  assert.equal(queries.length, 3);
  assert.equal(queries.every((sql) => sql.includes("ANY(") && sql.includes("::text[]")), true);
  assert.equal(resolveCanonicalMarketIdentity(context, prepared[0]).productIdentityId, "prd_gtin");

  prepared[0].raw.gtin = null;
  const alias = resolveCanonicalMarketIdentity(context, prepared[0]);
  assert.equal(alias.productIdentityId, "prd_alias");
  assert.equal(alias.resolutionKind, "verified_alias");
});

test("same-batch authoritative market disagreement persists one conflict memory row", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING status")) {
        const rows = JSON.parse(params[0]);
        return { rowCount: rows.length, rows: rows.map((row) => ({ status: row.memoryStatus })) };
      }
      if (sql.includes("fatedrop_product_market_observations")) return { rowCount: 2, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = { pool: async () => ({ connect: async () => client }) };
  const identity = { productIdentityId: "prd_shared", resolutionKind: "verified_identifier", confidence: 1 };
  const base = { identity, retailerId: "retailer-a", observedAt: 100, title: "Shared listing" };
  const result = await persistCanonicalMarketActions(store, [
    { ...base, offerId: "offer-jp", resolution: { status: "verified", marketCode: "JP", confidence: 1, source: "manufacturer", evidence: [] } },
    { ...base, offerId: "offer-kr", resolution: { status: "verified", marketCode: "KR", confidence: 1, source: "manufacturer", evidence: [] } },
  ], 100);
  const memoryCall = calls.find((call) => call.sql.includes("RETURNING status"));
  const memoryRows = JSON.parse(memoryCall.params[0]);
  assert.equal(memoryRows.length, 1);
  assert.equal(memoryRows[0].memoryStatus, "conflict");
  assert.deepEqual([memoryRows[0].observedMarketCode, memoryRows[0].conflictingMarketCode].sort(), ["JP", "KR"]);
  assert.equal(result.conflicts, 1);
});

test("a conflict against verified memory flips the canonical memory row to conflict", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING status")) return { rowCount: 1, rows: [{ status: "conflict" }] };
      if (sql.includes("fatedrop_product_market_observations")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = { pool: async () => ({ connect: async () => client }) };
  const result = await persistCanonicalMarketActions(store, [{
    identity: {
      productIdentityId: "prd_remembered",
      resolutionKind: "verified_identifier",
      confidence: 1,
      memory: { marketCode: "JP", status: "verified" },
    },
    retailerId: "retailer-b",
    offerId: "offer-conflict",
    title: "Abyss Eye Korean Booster Box",
    observedAt: 200,
    resolution: {
      status: "conflict",
      marketCode: null,
      candidateMarketCode: "KR",
      confidence: 0,
      source: "remembered_market_conflict",
      evidence: [{ marketCode: "KR", authority: "candidate", source: "listing_market_marker" }],
    },
  }], 200);
  const memoryCall = calls.find((call) => call.sql.includes("RETURNING status"));
  const [memory] = JSON.parse(memoryCall.params[0]);
  assert.equal(memory.memoryStatus, "conflict");
  assert.deepEqual([memory.observedMarketCode, memory.conflictingMarketCode].sort(), ["JP", "KR"]);
  assert.equal(result.conflicts, 1);
});
