import test from "node:test";
import assert from "node:assert/strict";
import { compareGroups, FateVerdictReason, rankGroups } from "../src/core/fate-verdict.mjs";

function group({ id, title, price, rrpGbp = null, delivery = 0 }) {
  const hasRrp = Number.isFinite(rrpGbp) && rrpGbp > 0;
  return {
    id,
    canonicalProductId: id,
    configurationId: id,
    title,
    identityKey: id,
    valueFamilyKey: "destined-rivals-etb-family",
    rrpGbp: hasRrp ? rrpGbp : null,
    rrpSource: hasRrp ? "verified-test-authority" : null,
    rrpKind: hasRrp ? "official" : null,
    offers: [{
      id: `${id}-offer`,
      retailerId: `${id}-retailer`,
      retailerName: `${title} Retailer`,
      priceGbp: price,
      shippingGbp: delivery,
      totalDeliveredGbp: price + delivery,
      deliveryKnown: true,
      stockStatus: "in_stock",
      lastCheckedAt: "2026-08-27T12:30:00.000Z",
    }],
  };
}

test("unknown RRP cannot outrank cheaper reference-backed FateFind candidates", () => {
  const unknownCheap = group({
    id: "unknown-cheap",
    title: "Unknown reference ETB",
    price: 40,
  });
  const knownHigherPremium = group({
    id: "known-higher-premium",
    title: "Known +60% ETB",
    price: 80,
    rrpGbp: 50,
  });
  const knownBest = group({
    id: "known-best",
    title: "Known +20% ETB",
    price: 60,
    rrpGbp: 50,
  });

  const verdict = rankGroups([unknownCheap, knownHigherPremium, knownBest]);

  assert.equal(verdict.winnerId, "known-best");
  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.deepEqual(verdict.ranking.map((position) => position.groupId), [
    "known-best",
    "known-higher-premium",
    "unknown-cheap",
  ]);
  assert.equal(verdict.ranking[0].rrpPercent, 20);
  assert.equal(verdict.ranking[2].rrpPercent, null);
  assert.match(verdict.reason, /outside the value ranking/i);
});

test("direct pair verdict remains fail-closed when only one configuration has RRP evidence", () => {
  const known = group({ id: "known", title: "Known ETB", price: 60, rrpGbp: 50 });
  const unknown = group({ id: "unknown", title: "Unknown ETB", price: 40 });

  const verdict = compareGroups(known, unknown);

  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.reasonCode, FateVerdictReason.NO_VERIFIED_REFERENCE);
});
