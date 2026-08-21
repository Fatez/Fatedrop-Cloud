import test from "node:test";
import assert from "node:assert/strict";
import { buildIdentityDryRunReport } from "../src/core/product-identity-report.mjs";

test("dry-run report separates safe matches, ambiguity and variant rejection without writes", () => {
  const report = buildIdentityDryRunReport([
    {
      retailerId: "retailer-a",
      title: "Pokémon TCG: Scarlet & Violet—151 Elite Trainer Box",
    },
    {
      retailerId: "retailer-b",
      title: "Pokemon Scarlet and Violet 151 ETB",
    },
    {
      retailerId: "retailer-a",
      title: "Pokemon Example Set Booster Box 36 Packs",
    },
    {
      retailerId: "retailer-b",
      title: "Pokemon Example Set Booster Box",
    },
    {
      retailerId: "retailer-c",
      title: "Pokemon Other Set Booster Box",
    },
    {
      retailerId: "retailer-d",
      title: "Pokemon Other Set Booster Box Case (6 Booster Boxes)",
    },
  ]);

  assert.equal(report.recordsSeen, 6);
  assert.equal(report.crossRetailerPairs, 3);
  assert.deepEqual(report.byDecision, { match: 1, ambiguous: 1, reject: 1 });
  assert.equal(report.matches[0].left.retailerId, "retailer-a");
  assert.ok(report.ambiguous[0].reasons.includes("pack_count_missing_on_one_side"));
  assert.match(report.rejected[0].reasons[0], /^unit_kind_conflict:/);
});

test("same-retailer lookalikes are not treated as cross-retailer comparison evidence", () => {
  const report = buildIdentityDryRunReport([
    { retailerId: "same-shop", title: "Pokemon Example Set Booster Box" },
    { retailerId: "same-shop", title: "Pokemon Example Set Booster Box Case (6 Booster Boxes)" },
  ]);

  assert.equal(report.crossRetailerPairs, 0);
  assert.deepEqual(report.byDecision, { match: 0, ambiguous: 0, reject: 0 });
});

test("different identity cores are not fuzzily forced into a candidate match", () => {
  const report = buildIdentityDryRunReport([
    { retailerId: "retailer-a", title: "Pokemon Scarlet & Violet 151 Elite Trainer Box" },
    { retailerId: "retailer-b", title: "Pokemon Scarlet & Violet Paldean Fates Elite Trainer Box" },
  ]);

  assert.equal(report.crossRetailerPairs, 0);
  assert.equal(report.byDecision.match, 0);
});
