import test from "node:test";
import assert from "node:assert/strict";
import { rrpAliasSignature, shouldQueueUnresolvedRrp, unresolvedRrpRecord } from "../src/core/rrp-learning.mjs";

test("RRP learning signature is stable across punctuation and case", () => {
  assert.equal(
    rrpAliasSignature({ tcg: "Pokemon", productType: "booster_box", title: "SWSH: Silver Tempest Booster Box!" }),
    rrpAliasSignature({ tcg: "pokemon", productType: "booster_box", title: "swsh silver-tempest booster box" }),
  );
});

test("mainstream UK-English sealed products are queued when RRP is unresolved", () => {
  assert.equal(shouldQueueUnresolvedRrp({ title: "SWSH Silver Tempest Booster Box", productType: "booster_box", tcg: "pokemon", language: "en", region: "GB" }), true);
});

test("imports and non-value product classes are not treated as UK RRP failures", () => {
  assert.equal(shouldQueueUnresolvedRrp({ title: "Mega Dream Japanese Booster Box", productType: "booster_box", tcg: "pokemon" }), false);
  assert.equal(shouldQueueUnresolvedRrp({ title: "Pikachu Binder", productType: "accessory", tcg: "pokemon" }), false);
});

test("unresolved record preserves retailer and product evidence", () => {
  const row = unresolvedRrpRecord({
    product: { id: "prd-1", tcg: "pokemon", productType: "booster_box" },
    offer: { offerId: "off-1", retailerId: "magic-madhouse", retailerSku: "sku-1", title: "SWSH Silver Tempest Booster Box", gtin: "123" },
    retailer: { id: "magic-madhouse" },
    observedAt: 123,
  });
  assert.equal(row.retailerId, "magic-madhouse");
  assert.equal(row.offerId, "off-1");
  assert.equal(row.evidence.retailer_sku, "sku-1");
  assert.match(row.id, /^rrpq_/);
});
