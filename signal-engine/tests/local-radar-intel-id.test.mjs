import assert from "node:assert/strict";
import test from "node:test";

import { attachLocalIntelIds, stableLocalIntelId } from "../src/encounters/local-radar-contract.mjs";

const expected = {
  title: "Pokémon TCG: Mega Forces Tin (Styles Vary)",
  productIdentityId: null,
  expectedFrom: "2026-08-29T00:00:00+01:00",
  expectedTo: "2026-08-29T23:59:59+01:00",
  expectedLabel: "Expected 29 August",
  sourceLabel: "The Entertainer official Pokémon TCG page",
  sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
};

test("Local Radar gives the same expected-stock intelligence a stable cross-branch intel ID", () => {
  const shops = attachLocalIntelIds([
    { id: "branch-a", localAvailability: { status: "expected", expected: { ...expected } } },
    { id: "branch-b", localAvailability: { status: "expected", expected: { ...expected } } },
  ]);

  assert.match(shops[0].localAvailability.expected.intelId, /^local_intel_[a-f0-9]{20}$/);
  assert.equal(shops[0].localAvailability.expected.intelId, shops[1].localAvailability.expected.intelId);
});

test("new expected-stock evidence creates a new intel ID without changing lifecycle truth", () => {
  const original = stableLocalIntelId(expected);
  const changed = stableLocalIntelId({ ...expected, expectedLabel: "Expected 30 August", expectedFrom: "2026-08-30T00:00:00+01:00" });
  assert.notEqual(original, changed);

  const [shop] = attachLocalIntelIds([{
    id: "confirmed-with-next-arrival",
    localAvailability: {
      status: "confirmed",
      confirmed: { title: "Product already confirmed" },
      expected: { ...expected },
    },
  }]);
  assert.equal(shop.localAvailability.status, "confirmed");
  assert.equal(shop.localAvailability.confirmed.title, "Product already confirmed");
  assert.equal(shop.localAvailability.expected.intelId, original);
});
