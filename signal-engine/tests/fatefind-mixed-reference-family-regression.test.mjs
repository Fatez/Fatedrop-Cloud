import test from "node:test";
import assert from "node:assert/strict";

import {
  compareGroups,
  FateComparisonMode,
  FateVerdictReason,
  sameComparableFamily,
} from "../src/core/fate-verdict.mjs";

function offer(id, priceGbp) {
  return {
    id,
    retailerId: `${id}-retailer`,
    retailerName: "Regression Retailer",
    priceGbp,
    shippingGbp: null,
    totalDeliveredGbp: null,
    deliveryKnown: false,
    stockStatus: "in_stock",
    lastCheckedAt: "2026-08-27T14:45:00.000Z",
  };
}

const fourPack = {
  id: "prd_ccd5b5caa617f8d46cd61d91",
  canonicalProductId: "prd_ccd5b5caa617f8d46cd61d91",
  configurationId: "prd_ccd5b5caa617f8d46cd61d91",
  title: "Destined Rivals - 4 Pack Bundle — Sealed",
  identityKey: "other:destined rivals 4 pack bundle sealed",
  valueFamilyKey: "rrp:booster_pack:prd_dc07e8630f2b6d272bbcfa10",
  rrpGbp: 17.16,
  rrpSource: "component:asmodee-uk",
  rrpKind: "component_reference",
  rrpReferenceBasis: "4 × verified booster-pack RRP",
  unitCount: 4,
  unitKind: "booster_pack",
  unitRrpGbp: 4.29,
  offers: [offer("off-destined-4", 66.95)],
};

const zebstrikaBlister = {
  id: "prd_4faee63bafcfea1c7e51d43b",
  canonicalProductId: "prd_4faee63bafcfea1c7e51d43b",
  configurationId: "prd_4faee63bafcfea1c7e51d43b",
  title: "Pokemon - Scarlet & Violet - Destined Rivals - 3 Pack Blister - Zebstrika",
  identityKey: "other:scarlet and violet destined rivals 3 pack blister zebstrika",
  valueFamilyKey: "rrp:other:prd_4faee63bafcfea1c7e51d43b",
  rrpGbp: 13.99,
  rrpSource: "pokemon-center-uk",
  rrpKind: "official",
  rrpReferenceBasis: "Verified official RRP for this product identity",
  unitCount: 1,
  unitKind: "other",
  unitRrpGbp: 13.99,
  offers: [offer("off-destined-zebstrika", 31.95)],
};

test("P0: Destined Rivals 4-pack component reference remains comparable with stronger official 3-pack blister RRP", () => {
  assert.equal(sameComparableFamily(fourPack, zebstrikaBlister), true);

  const verdict = compareGroups(fourPack, zebstrikaBlister);
  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.winnerId, zebstrikaBlister.id);
  assert.ok(Math.abs(verdict.left.rrpPercent - (((66.95 - 17.16) / 17.16) * 100)) < 1e-9);
  assert.ok(Math.abs(verdict.right.rrpPercent - (((31.95 - 13.99) / 13.99) * 100)) < 1e-9);
  assert.equal(verdict.left.deliveryKnown, false);
  assert.equal(verdict.right.deliveryKnown, false);
  assert.match(verdict.reason, /not a like-for-like product comparison/i);
});

test("different named expansions stay distinct families but can compare normalized % vs each trusted own RRP", () => {
  const otherExpansion = {
    ...zebstrikaBlister,
    id: "surging-sparks-blister",
    canonicalProductId: "surging-sparks-blister",
    configurationId: "surging-sparks-blister",
    title: "Pokemon - Scarlet & Violet - Surging Sparks - 3 Pack Blister - Zapdos",
    identityKey: "other:scarlet and violet surging sparks 3 pack blister zapdos",
    valueFamilyKey: "rrp:other:surging-sparks-blister",
    offers: [offer("off-surging-sparks", 31.95)],
  };

  assert.equal(sameComparableFamily(fourPack, otherExpansion), false);
  const verdict = compareGroups(fourPack, otherExpansion);
  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.winnerId, otherExpansion.id);
});

test("the release fallback does not merge arbitrary official configurations", () => {
  const officialEtb = {
    ...zebstrikaBlister,
    id: "destined-rivals-etb",
    canonicalProductId: "destined-rivals-etb",
    configurationId: "destined-rivals-etb",
    title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Elite Trainer Box",
    identityKey: "elite_trainer_box:scarlet and violet 10 destined rivals elite trainer box",
    valueFamilyKey: "rrp:elite_trainer_box:destined-rivals-etb",
    rrpGbp: 49.99,
    unitRrpGbp: 49.99,
    unitKind: "elite_trainer_box",
    offers: [offer("off-destined-etb", 55)],
  };

  assert.equal(sameComparableFamily(officialEtb, zebstrikaBlister), false);

  const verdict = compareGroups(officialEtb, zebstrikaBlister);
  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
});

test("real source-market MSRP can be calculated but cannot enter an unrelated normalized UK RRP comparison", () => {
  const imported = {
    id: "destined-rivals-jp-import",
    canonicalProductId: "destined-rivals-jp-import",
    configurationId: "destined-rivals-jp-import",
    title: "Pokemon - Destined Rivals - Japanese Booster Pack",
    identityKey: "booster_pack:destined rivals japanese booster pack",
    valueFamilyKey: "source-msrp:jp-destined-rivals:standard",
    rrpGbp: 1,
    rrpSource: "official-msrp:jp:jp-destined-rivals:standard:https://example.com/jp-authority",
    rrpKind: "source_market_msrp",
    rrpReferenceBasis: "Official Japan MSRP converted to GBP; source-market reference, not a UK RRP.",
    unitCount: 1,
    unitKind: "booster_pack",
    unitRrpGbp: 1,
    offers: [offer("off-destined-import", 2)],
  };

  assert.equal(sameComparableFamily(fourPack, imported), false);
  const verdict = compareGroups(fourPack, imported);
  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.reasonCode, FateVerdictReason.NO_VERIFIED_REFERENCE);
  assert.equal(verdict.comparisonMode, null);
  assert.equal(verdict.right.rrpPercent, 100);
  assert.equal(verdict.right.referenceEligible, true);
  assert.match(verdict.right.reference.basis, /not a UK RRP/i);
});

test("same verified source-market family can compare pack vs box without becoming UK RRP", () => {
  const pack = {
    id: "jp-abyss-pack-targeted",
    canonicalProductId: "jp-abyss-pack-targeted",
    configurationId: "jp-abyss-pack-targeted",
    title: "Pokemon - Mega Evolution - Abyss Eye - Japanese Booster Pack",
    identityKey: "booster_pack:abyss eye japanese",
    valueFamilyKey: "source-msrp:jp-abyss-eye:standard",
    rrpGbp: 0.92,
    rrpSource: "official-msrp:jp:jp-abyss-eye:standard:https://example.com/jp-authority",
    rrpKind: "source_market_msrp",
    rrpReferenceBasis: "Official Japan MSRP ¥200 per booster pack; converted to GBP. This is a source-market reference, not a UK RRP.",
    unitCount: 1,
    unitKind: "booster_pack",
    unitRrpGbp: 0.92,
    offers: [offer("off-jp-abyss-pack-targeted", 3.25)],
  };
  const box = {
    id: "jp-abyss-box-targeted",
    canonicalProductId: "jp-abyss-box-targeted",
    configurationId: "jp-abyss-box-targeted",
    title: "Pokemon - Mega Evolution - Abyss Eye - Japanese Booster Box (30 Packs)",
    identityKey: "booster_box:abyss eye japanese",
    valueFamilyKey: "source-msrp:jp-abyss-eye:standard",
    rrpGbp: 27.62,
    rrpSource: "official-msrp:jp:jp-abyss-eye:standard:https://example.com/jp-authority",
    rrpKind: "source_market_component_reference",
    rrpReferenceBasis: "Official Japan MSRP ¥6,000 for 30 comparable booster packs; converted to GBP. This is a source-market reference, not a UK RRP.",
    unitCount: 30,
    unitKind: "booster_pack",
    unitRrpGbp: null,
    offers: [offer("off-jp-abyss-box-targeted", 84.95)],
  };

  assert.equal(sameComparableFamily(pack, box), true);
  assert.notEqual(pack.identityKey, box.identityKey);

  const verdict = compareGroups(pack, box);
  assert.equal(verdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(verdict.basis, "rrp_percent");
  assert.equal(verdict.comparisonMode, FateComparisonMode.NORMALIZED_OWN_RRP);
  assert.equal(verdict.winnerId, box.id);
  assert.match(verdict.left.reference.basis, /not a UK RRP/i);
  assert.match(verdict.right.reference.basis, /not a UK RRP/i);
});