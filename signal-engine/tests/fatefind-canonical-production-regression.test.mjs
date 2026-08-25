import assert from "node:assert/strict";
import test from "node:test";

import { compareGroups, FateVerdictReason } from "../src/core/fate-verdict.mjs";
import { createHttpServer } from "../src/http/server.mjs";

const OBSERVED_AT = 1787662686;
const STANDARD_PACK_ID = "prd_destined_rivals_standard_pack";
const TEN_ID = "prd_destined_rivals_10_pack_sealed";
const FOUR_ID = "prd_destined_rivals_4_pack_sealed";
const PLACEHOLDER_ID = "prd_destined_rivals_8_pack_placeholder";

const products = [
  {
    id: STANDARD_PACK_ID,
    canonicalKey: "booster_pack:scarlet and violet 10 destined rivals booster pack",
    title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 429,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1787608630,
  },
  {
    id: TEN_ID,
    canonicalKey: "other:destined rivals 10 pack bundle sealed",
    title: "Destined Rivals - 10 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  },
  {
    id: FOUR_ID,
    canonicalKey: "other:destined rivals 4 pack bundle sealed",
    title: "Destined Rivals - 4 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  },
  {
    id: PLACEHOLDER_ID,
    canonicalKey: "other:destined rivals 8 pack bundle sealed",
    title: "Destined Rivals - 8 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  },
];

const offers = [
  {
    offerId: "off_destined_10",
    productId: TEN_ID,
    retailerId: "card-collective",
    retailerName: "Card Collective UK",
    retailerSku: "destined-10",
    title: "Destined Rivals - 10 Pack Bundle — Sealed",
    url: "https://example.com/destined-10",
    pricePence: 16695,
    postagePence: 0,
    stockStatus: "in_stock",
    lastSeenAt: OBSERVED_AT,
  },
  {
    offerId: "off_destined_4",
    productId: FOUR_ID,
    retailerId: "unknown-delivery-retailer",
    retailerName: "Unknown Delivery Retailer",
    retailerSku: "destined-4",
    title: "Destined Rivals - 4 Pack Bundle — Sealed",
    url: "https://example.com/destined-4",
    pricePence: 6695,
    postagePence: null,
    stockStatus: "in_stock",
    lastSeenAt: OBSERVED_AT,
  },
  {
    offerId: "off_destined_single",
    productId: STANDARD_PACK_ID,
    retailerId: "unknown-delivery-retailer",
    retailerName: "Unknown Delivery Retailer",
    retailerSku: "destined-single",
    title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
    url: "https://example.com/destined-single",
    pricePence: 699,
    postagePence: null,
    stockStatus: "in_stock",
    lastSeenAt: OBSERVED_AT,
  },
  {
    offerId: "off_destined_placeholder",
    productId: PLACEHOLDER_ID,
    retailerId: "placeholder-retailer",
    retailerName: "Placeholder Retailer",
    retailerSku: "destined-placeholder",
    title: "Destined Rivals - 8 Pack Bundle — Sealed",
    url: "https://example.com/destined-placeholder",
    pricePence: 1,
    postagePence: 0,
    stockStatus: "in_stock",
    lastSeenAt: OBSERVED_AT,
  },
];

const store = {
  async listOffers() { return offers; },
  async listProducts() { return products; },
};

async function withServer(fn, customStore = store) {
  const server = createHttpServer({ store: customStore });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function postVerdict(base, body) {
  const response = await fetch(`${base}/api/fatefind/matches`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ mode: "verdict", query: "Destined Rivals", ...body }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);
}

test("canonical Cloud route keeps 1-pack, 4-pack and 10-pack distinct while sharing one verified value family", async () => withServer(async (base) => {
  const data = await postVerdict(base, {});
  assert.equal(data.success, true);
  assert.equal(data.mode, "verdict");
  assert.equal(data.source, "FATEDROP_CLOUD");
  assert.equal(data.rulesVersion, "fate-verdict-v2");

  const ten = data.groups.find((group) => group.id === TEN_ID);
  const four = data.groups.find((group) => group.id === FOUR_ID);
  const single = data.groups.find((group) => group.id === STANDARD_PACK_ID);
  assert.ok(ten);
  assert.ok(four);
  assert.ok(single);
  assert.notEqual(ten.id, four.id);
  assert.notEqual(four.id, single.id);
  assert.notEqual(ten.identityKey, four.identityKey);
  assert.equal(ten.valueFamilyKey, four.valueFamilyKey);
  assert.equal(four.valueFamilyKey, single.valueFamilyKey);

  assert.equal(ten.unitCount, 10);
  assert.equal(four.unitCount, 4);
  assert.equal(single.unitCount, 1);
  assert.equal(ten.unitKind, "booster_pack");
  assert.equal(four.unitKind, "booster_pack");
  assert.equal(single.unitKind, "booster_pack");
  closeTo(ten.rrpGbp, 42.90);
  closeTo(four.rrpGbp, 17.16);
  closeTo(single.rrpGbp, 4.29);
  assert.match(ten.rrpReferenceBasis, /10 × verified booster-pack RRP/);
  assert.match(four.rrpReferenceBasis, /4 × verified booster-pack RRP/);
}));

test("physical iPhone failure class returns a canonical 10-pack vs 4-pack pair verdict while both offers qualify", async () => withServer(async (base) => {
  const data = await postVerdict(base, { leftId: TEN_ID, rightId: FOUR_ID });
  assert.ok(data.pairVerdict);
  assert.equal(data.pairVerdict.basis, "rrp_percent");
  assert.equal(data.pairVerdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(data.pairVerdict.winnerId, TEN_ID);
  assert.equal(data.pairVerdict.left.groupId, TEN_ID);
  assert.equal(data.pairVerdict.right.groupId, FOUR_ID);
  closeTo(data.pairVerdict.left.rrpGbp, 42.90);
  closeTo(data.pairVerdict.right.rrpGbp, 17.16);
  closeTo(data.pairVerdict.left.rrpPercent, ((166.95 - 42.90) / 42.90) * 100);
  closeTo(data.pairVerdict.right.rrpPercent, ((66.95 - 17.16) / 17.16) * 100);
}));

test("a selected configuration that sells out between list and verdict stays identified but fails with NO_QUALIFYING_LIVE_OFFERS", async () => {
  const soldOutOffers = offers.map((offer) => offer.productId === FOUR_ID ? { ...offer, stockStatus: "out_of_stock" } : offer);
  const soldOutStore = {
    async listOffers() { return soldOutOffers; },
    async listProducts() { return products; },
  };

  await withServer(async (base) => {
    const data = await postVerdict(base, { leftId: TEN_ID, rightId: FOUR_ID });
    assert.ok(data.pairVerdict);
    assert.equal(data.pairVerdict.winnerId, null);
    assert.equal(data.pairVerdict.reasonCode, FateVerdictReason.NO_QUALIFYING_LIVE_OFFERS);
    assert.match(data.pairVerdict.reason, /qualifying live commercial offer/i);
  }, soldOutStore);
});

test("a different pair with two current qualifying offers still returns a production-compatible winner", async () => withServer(async (base) => {
  const data = await postVerdict(base, { leftId: TEN_ID, rightId: STANDARD_PACK_ID });
  assert.ok(data.pairVerdict);
  assert.equal(data.pairVerdict.reasonCode, FateVerdictReason.WINNER_RRP_PERCENT);
  assert.equal(data.pairVerdict.basis, "rrp_percent");
  assert.equal(data.pairVerdict.winnerId, STANDARD_PACK_ID);
}));

test("delivery stays separate from item-price-vs-RRP and unknown delivery never becomes zero", async () => withServer(async (base) => {
  const data = await postVerdict(base, { leftId: TEN_ID, rightId: FOUR_ID });
  const four = data.pairVerdict.right;
  assert.equal(four.itemPrice, 66.95);
  assert.equal(four.deliveryKnown, false);
  assert.equal(four.truePrice, null);
  assert.equal(four.checkoutCost, null);
  assert.equal(four.truePriceEvidence.deliveryGbp, null);
  assert.equal(four.truePriceEvidence.totalGbp, null);
  closeTo(four.rrpPercent, ((66.95 - 17.16) / 17.16) * 100);
}));

test("£0.01 placeholder observations cannot enter True Price groups or win Fate Verdict", async () => withServer(async (base) => {
  const data = await postVerdict(base, {});
  assert.equal(data.groups.some((group) => group.id === PLACEHOLDER_ID), false);
  assert.equal(data.verdict.ranking.some((position) => position.groupId === PLACEHOLDER_ID), false);
}));

test("unresolved selected configuration returns a structured reason instead of an ambiguous empty pair", async () => withServer(async (base) => {
  const data = await postVerdict(base, { leftId: TEN_ID, rightId: "missing-configuration" });
  assert.ok(data.pairVerdict);
  assert.equal(data.pairVerdict.winnerId, null);
  assert.equal(data.pairVerdict.reasonCode, FateVerdictReason.IDENTITY_UNRESOLVED);
  assert.match(data.pairVerdict.reason, /resolve both selected canonical product configurations/i);
}));

test("verdict response exposes non-secret Railway Git SHA for exact runtime certification", async () => {
  const previous = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = "test-runtime-sha";
  try {
    await withServer(async (base) => {
      const data = await postVerdict(base, { leftId: TEN_ID, rightId: STANDARD_PACK_ID });
      assert.equal(data.runtime.gitCommitSha, "test-runtime-sha");
    });
  } finally {
    if (previous === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = previous;
  }
});

test("missing verified family/reference fails closed", () => {
  const left = {
    id: "left",
    identityKey: "other:left",
    valueFamilyKey: null,
    title: "Unverified 4 Pack",
    unitCount: 4,
    unitKind: "booster_pack",
    offers: [{ id: "left-offer", priceGbp: 20, deliveryKnown: false }],
  };
  const right = {
    id: "right",
    identityKey: "other:right",
    valueFamilyKey: null,
    title: "Unverified 10 Pack",
    unitCount: 10,
    unitKind: "booster_pack",
    offers: [{ id: "right-offer", priceGbp: 40, deliveryKnown: false }],
  };
  const verdict = compareGroups(left, right);
  assert.equal(verdict.winnerId, null);
  assert.equal(verdict.reasonCode, FateVerdictReason.CONFIGURATION_NOT_COMPARABLE);
});
