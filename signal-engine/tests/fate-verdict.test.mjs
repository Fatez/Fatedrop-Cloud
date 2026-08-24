import assert from "node:assert/strict";
import test from "node:test";

import { compareGroups, rankGroups, valuePosition } from "../src/core/fate-verdict.mjs";

function group(id, title, unitCount, itemPrice, { delivery = 0, deliveryKnown = true } = {}) {
  return {
    id,
    title,
    unitCount,
    unitKind: "booster_pack",
    unitRrpGbp: 4.29,
    offers: [{
      id: `${id}:offer`,
      retailerId: "retailer",
      retailerName: "Retailer",
      priceGbp: itemPrice,
      shippingGbp: deliveryKnown ? delivery : undefined,
      totalDeliveredGbp: deliveryKnown ? itemPrice + delivery : undefined,
      deliveryKnown,
    }],
  };
}

test("10 packs at £140 beats 4 packs at £60 when each pack has a £4.29 RRP basis", () => {
  const four = group("four", "4 pack bundle", 4, 60);
  const ten = group("ten", "10 pack bundle", 10, 140);
  const verdict = compareGroups(four, ten);

  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.winnerId, "ten");
  assert.ok(Math.abs(verdict.left.rrpGbp - 17.16) < 0.001);
  assert.ok(Math.abs(verdict.right.rrpGbp - 42.90) < 0.001);
  assert.ok(verdict.right.rrpPercent < verdict.left.rrpPercent);
});

test("FateFind ranks bundle value against scaled RRP rather than lowest sticker price", () => {
  const verdict = rankGroups([
    group("four", "4 pack bundle", 4, 60),
    group("ten", "10 pack bundle", 10, 140),
    group("six", "6 pack bundle", 6, 90),
  ]);
  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.winnerId, "ten");
});

test("delivery changes True Price but never changes the RRP markup percentage", () => {
  const freeDelivery = valuePosition(group("free", "4 pack bundle", 4, 60));
  const paidDelivery = valuePosition(group("paid", "4 pack bundle", 4, 60, { delivery: 5 }));
  assert.equal(freeDelivery.rrpPercent, paidDelivery.rrpPercent);
  assert.equal(freeDelivery.truePrice, 60);
  assert.equal(paidDelivery.truePrice, 65);
});

test("unknown delivery remains provisional and is never converted to free delivery", () => {
  const position = valuePosition(group("unknown", "4 pack bundle", 4, 60, { deliveryKnown: false }));
  assert.equal(position.truePrice, null);
  assert.equal(position.checkoutCost, 60);
  assert.equal(position.provisional, true);
  assert.equal(position.deliveryKnown, false);
});
