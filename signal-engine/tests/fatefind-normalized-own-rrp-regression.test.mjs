import test from "node:test";
import assert from "node:assert/strict";

import {
  compareGroups,
  FateComparisonMode,
  FateVerdictReason,
  rankGroups,
  sameComparableFamily,
} from "../src/core/fate-verdict.mjs";

function offer(id, priceGbp, { deliveryGbp = null } = {}) {
  const deliveryKnown = Number.isFinite(deliveryGbp);
  return {
    id,
    retailerId: `${id}-retailer`,
    retailerName: "Regression Retailer",
    priceGbp,
    shippingGbp: deliveryKnown ? deliveryGbp : null,
    totalDeliveredGbp: deliveryKnown ? priceGbp + deliveryGbp : null,
    deliveryKnown,
    stockStatus: "in_stock",
    lastCheckedAt: "2026-08-27T17:45:00.000Z",
  };
}

function officialGroup({ id, title, identityKey, priceGbp, rrpGbp, unitKind, valueFamilyKey = null, deliveryGbp = null }) {
  return {
    id,
    canonicalProductId: id,
    configurationId: id,
    title,
    identityKey,
    valueFamilyKey,
    rrpGbp,
    rrpSource: "asmodee-uk",
    rrpKind: "official",
    rrpReferenceBasis: "Verified official RRP for this product identity",
    unitCount: 1,
    unitKind,
    unitRrpGbp: rrpGbp,
    offers: [offer(`${id}-offer`, priceGbp, { deliveryGbp })],
  };
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);
}

const destinedRivalsPack = officialGroup({
  id: "prd_destined_rivals_booster_pack_real_case",
  title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
  identityKey: "booster_pack:scarlet and violet 10 destined rivals booster pack",
  valueFamilyKey: "rrp:booster_pack:prd_destined_rivals_booster_pack_real_case",
  priceGbp: 9.99,
  rrpGbp: 4.29,
  unitKind: "booster_pack",
});

const destinedRivalsBox = officialGroup({
  id: "prd_destined_rivals_booster_display_real_case",
  title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Display Box (36 Packs)",
  identityKey: "booster_box:scarlet and violet 10 destined rivals booster display box 36 packs",
  valueFamilyKey: "rrp:booster_box:prd_destined_rivals_booster_display_real_case",
  priceGbp: 334.95,
  rrpGbp: 151.99,
  unitKind: "booster_box",
});

test("P0 real case: Destined Rivals pack vs booster box ranks by % vs each own verified RRP without merging identities", () => {
  assert.equal(sameComparableFamily(destinedRivalsPack, destinedRivalsBox), false);
  assert.notEqual(destinedRivalsPack.identityKey, destinedRivalsBox.identityKey);

  const verdict = compareGroups(destinedRivalsPack, destinedRivalsBox);

  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.winnerId, destinedRivalsBox.id);
  closeTo(verdict.left.rrpPercent, ((9.99 - 4.29) / 4.29) * 100);
  closeTo(verdict.right.rrpPercent, ((334.95 - 151.99) / 151.99) * 100);
  closeTo(verdict.left.rrpPercent, 132.86713286713285);
  closeTo(verdict.right.rrpPercent, 120.38949930916498);
  assert.match(verdict.reason, /normalized % vs own RRP/i);
  assert.match(verdict.reason, /not a like-for-like product comparison/i);
});

test("unlike products tied on % vs own RRP do not use lower absolute checkout price as a false tie-break", () => {
  const pack = officialGroup({
    id: "tie-pack",
    title: "Tie Release Booster Pack",
    identityKey: "booster_pack:tie release booster pack",
    valueFamilyKey: "rrp:booster_pack:tie-pack",
    priceGbp: 5.50,
    rrpGbp: 5,
    unitKind: "booster_pack",
    deliveryGbp: 0,
  });
  const box = officialGroup({
    id: "tie-box",
    title: "Tie Release Booster Box",
    identityKey: "booster_box:tie release booster box",
    valueFamilyKey: "rrp:booster_box:tie-box",
    priceGbp: 165,
    rrpGbp: 150,
    unitKind: "booster_box",
    deliveryGbp: 0,
  });

  const verdict = compareGroups(pack, box);
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.reasonCode, FateVerdictReason.TIED_EVIDENCE);
  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.left.rrpPercent, 10);
  assert.equal(verdict.right.rrpPercent, 10);
  assert.notEqual(verdict.left.truePrice, verdict.right.truePrice);
  assert.match(verdict.reason, /absolute checkout price is not a safe cross-product tie-break/i);
});

test("untrusted/manual reference evidence stays outside normalized RRP comparison", () => {
  const manual = {
    ...destinedRivalsBox,
    id: "manual-reference-box",
    canonicalProductId: "manual-reference-box",
    configurationId: "manual-reference-box",
    identityKey: "booster_box:manual reference box",
    rrpKind: "manual",
    rrpSource: "manual-entry",
    offers: [offer("manual-reference-offer", 100)],
  };

  const verdict = compareGroups(destinedRivalsPack, manual);
  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.reasonCode, FateVerdictReason.NO_VERIFIED_REFERENCE);
  assert.equal(verdict.comparisonMode, null);
  assert.equal(verdict.right.rrpPercent, null);
  assert.equal(verdict.right.referenceEligible, false);
});

test("conflicting direct and scaled RRP evidence fails closed", () => {
  const conflict = {
    ...destinedRivalsPack,
    id: "conflicting-reference",
    canonicalProductId: "conflicting-reference",
    configurationId: "conflicting-reference",
    identityKey: "other:conflicting reference",
    rrpGbp: 10,
    unitRrpGbp: 4,
    unitCount: 3,
    rrpKind: "component_reference",
    rrpSource: "component:asmodee-uk",
    offers: [offer("conflicting-reference-offer", 11)],
  };

  const verdict = compareGroups(destinedRivalsPack, conflict);
  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.reasonCode, FateVerdictReason.NO_VERIFIED_REFERENCE);
  assert.equal(verdict.right.rrpPercent, null);
  assert.equal(verdict.right.reference, null);
});

test("trusted RRP cannot rescue an unresolved canonical identity", () => {
  const unresolved = {
    ...destinedRivalsBox,
    id: "unresolved-box",
    canonicalProductId: "unresolved-box",
    configurationId: "unresolved-box",
    identityKey: null,
    offers: [offer("unresolved-box-offer", 200)],
  };

  const verdict = compareGroups(destinedRivalsPack, unresolved);
  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.reasonCode, FateVerdictReason.IDENTITY_UNRESOLVED);
  assert.equal(verdict.right.rrpPercent, null);
  assert.equal(verdict.right.referenceEligible, false);
});

test("FateFind ranking can normalize multiple distinct trusted identities while unsafe references remain outside the ranking", () => {
  const etb = officialGroup({
    id: "destined-rivals-etb-ranking",
    title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Elite Trainer Box",
    identityKey: "elite_trainer_box:scarlet and violet 10 destined rivals elite trainer box",
    valueFamilyKey: "rrp:elite_trainer_box:destined-rivals-etb-ranking",
    priceGbp: 54.99,
    rrpGbp: 49.99,
    unitKind: "elite_trainer_box",
  });
  const imported = {
    ...officialGroup({
      id: "jp-import-ranking",
      title: "Japanese Import Booster Box",
      identityKey: "booster_box:japanese import booster box",
      valueFamilyKey: "rrp:booster_box:jp-import-ranking",
      priceGbp: 1,
      rrpGbp: 1,
      unitKind: "booster_box",
    }),
    rrpKind: "international_msrp",
    rrpSource: "official-jp-msrp",
  };

  const verdict = rankGroups([destinedRivalsPack, destinedRivalsBox, etb, imported]);

  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.winnerId, etb.id);
  assert.deepEqual(verdict.ranking.slice(0, 3).map((position) => position.groupId), [
    etb.id,
    destinedRivalsBox.id,
    destinedRivalsPack.id,
  ]);
  assert.equal(verdict.ranking.at(-1).groupId, imported.id);
  assert.equal(verdict.ranking.at(-1).rrpPercent, null);
  assert.match(verdict.reason, /identities remain distinct/i);
  assert.match(verdict.reason, /outside the value ranking/i);
});

test("normalized multi-product ranking also refuses absolute True Price as an equal-percent tie-break", () => {
  const cheap = officialGroup({
    id: "rank-tie-cheap",
    title: "Rank Tie Booster Pack",
    identityKey: "booster_pack:rank tie booster pack",
    valueFamilyKey: "rrp:booster_pack:rank-tie-cheap",
    priceGbp: 11,
    rrpGbp: 10,
    unitKind: "booster_pack",
    deliveryGbp: 0,
  });
  const expensive = officialGroup({
    id: "rank-tie-expensive",
    title: "Rank Tie Booster Box",
    identityKey: "booster_box:rank tie booster box",
    valueFamilyKey: "rrp:booster_box:rank-tie-expensive",
    priceGbp: 220,
    rrpGbp: 200,
    unitKind: "booster_box",
    deliveryGbp: 0,
  });

  const verdict = rankGroups([cheap, expensive]);
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.reasonCode, FateVerdictReason.TIED_EVIDENCE);
  assert.equal(verdict.winnerId, null);
  assert.match(verdict.reason, /absolute checkout price is not used as a cross-product tie-break/i);
});
