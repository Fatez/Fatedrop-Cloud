import test from "node:test";
import assert from "node:assert/strict";

import { buildRetailerPreparationClusters, preparationFamilyKey } from "../src/core/preparation-cluster.mjs";
import { deriveSignal } from "../src/core/signals.mjs";

const structured = (sku) => [{ kind: "shopify_structured_catalogue", value: `variant:${sku}` }];
const offer = (status, extra = {}) => ({
  offerId: "off_1",
  productId: "prd_1",
  retailerId: "eterna-cards",
  retailerName: "Eterna Cards",
  retailerSku: "SKU-1",
  title: "Pokemon Delta Reign Elite Trainer Box",
  productType: "elite_trainer_box",
  url: "https://example.test/delta-reign-etb",
  pricePence: 1,
  rrpPence: 4999,
  postagePence: 299,
  stockStatus: status,
  stockConfidence: 0.98,
  evidence: structured("SKU-1"),
  everAvailableAt: null,
  firstSeenAt: 100,
  lastSeenAt: 100,
  ...extra,
});

function deltaPrepared() {
  const rows = [
    ["booster-pack", "Pokemon Delta Reign Booster Pack", "booster_pack"],
    ["etb", "Pokemon Delta Reign Elite Trainer Box", "elite_trainer_box"],
    ["bundle", "Pokemon Delta Reign Booster Bundle", "booster_bundle"],
    ["box", "Pokemon Delta Reign Booster Box (36 Packs)", "booster_box"],
    ["blister", "Pokemon Delta Reign 3-Pack Blister", "other"],
    ["ampharos", "Pokemon Delta Reign Premium Checklane Blister — Ampharos", "other"],
    ["delphox", "Pokemon Delta Reign Premium Checklane Blister — Delphox", "other"],
  ];
  return rows.map(([sku, title, productType]) => ({
    offerId: `off_${sku}`,
    productId: `prd_${sku}`,
    raw: {
      retailerSku: sku,
      title,
      productType,
      url: `https://example.test/${sku}`,
      pricePence: 1,
      stockStatus: "out_of_stock",
      evidence: structured(sku),
    },
  }));
}

test("Delta Reign product configurations reduce to the shared preparation family", () => {
  assert.equal(preparationFamilyKey("Pokemon Delta Reign Elite Trainer Box"), "delta reign");
  assert.equal(preparationFamilyKey("Pokemon Delta Reign Booster Box (36 Packs)"), "delta reign");
  assert.equal(preparationFamilyKey("Pokemon Delta Reign 3-Pack Blister"), "delta reign");
  assert.equal(preparationFamilyKey("Pokemon Delta Reign Premium Checklane Blister — Ampharos"), "delta reign");
  assert.equal(preparationFamilyKey("Pokemon Delta Reign Premium Checklane Blister — Delphox"), "delta reign");
});

test("real Delta Reign-style multi-SKU sentinel activation creates one strong preparation cluster", () => {
  const prepared = deltaPrepared();
  const result = buildRetailerPreparationClusters({ retailerId: "eterna-cards", prepared, previousOffers: new Map(), now: 200 });
  assert.equal(result.clusters.length, 1);
  const cluster = result.clusters[0];
  assert.equal(cluster.productFamilyKey, "delta reign");
  assert.equal(cluster.skuCount, 7);
  assert.ok(cluster.productTypeCount >= 4);
  assert.equal(cluster.placeholderPriceCount, 7);
  assert.equal(cluster.structuredEvidenceCount, 7);
  assert.equal(cluster.activationMode, "new_family_activation");
  assert.equal(cluster.leaderOfferId, "off_etb");
  assert.equal(result.byOfferId.size, 7);
});

test("a lone random one-penny listing is not enough to create a preparation cluster", () => {
  const result = buildRetailerPreparationClusters({ retailerId: "eterna-cards", prepared: [deltaPrepared()[0]], previousOffers: new Map(), now: 200 });
  assert.equal(result.clusters.length, 0);
});

test("quiet-baseline family activation can be confirmed on the next observation without repeating forever", () => {
  const prepared = deltaPrepared();
  const previousAtFirstObservation = new Map(prepared.map((item) => [item.offerId, { firstSeenAt: 100, lastSeenAt: 100 }]));
  const confirmed = buildRetailerPreparationClusters({ retailerId: "eterna-cards", prepared, previousOffers: previousAtFirstObservation, now: 200 });
  assert.equal(confirmed.clusters.length, 1);
  assert.equal(confirmed.clusters[0].activationMode, "confirmed_family_activation");

  const previousAfterConfirmation = new Map(prepared.map((item) => [item.offerId, { firstSeenAt: 100, lastSeenAt: 200 }]));
  const repeated = buildRetailerPreparationClusters({ retailerId: "eterna-cards", prepared, previousOffers: previousAfterConfirmation, now: 300 });
  assert.equal(repeated.clusters.length, 0);
});

test("first sentinel observation stays Whisper while repeated corroborated preparation becomes Echo", () => {
  const first = deriveSignal({ previousOffer: null, currentOffer: offer("out_of_stock"), now: 100 });
  assert.equal(first.state, "whisper");
  assert.equal(first.pricePence, null);
  assert.equal(first.rawObservedPricePence, 1);
  assert.equal(first.markupPercent, null);

  const second = deriveSignal({ previousOffer: offer("out_of_stock", { firstSeenAt: 100, lastSeenAt: 100 }), currentOffer: offer("out_of_stock", { firstSeenAt: 100, lastSeenAt: 200 }), now: 200 });
  assert.equal(second.state, "echo");
  assert.equal(second.kind, "retailer_preparation");
  assert.equal(second.pricePence, null);
  assert.ok(second.evidence.some((entry) => entry.kind === "price_quality" && entry.value === "placeholder"));
  assert.ok(second.evidence.some((entry) => entry.kind === "retailer_preparation_repeated"));
});

test("cluster leader creates the representative Echo", () => {
  const current = offer("out_of_stock", {
    evidence: [...structured("SKU-1"), { kind: "retailer_preparation_cluster", value: "prep_delta_reign", leaderOfferId: "off_1" }],
  });
  const signal = deriveSignal({ previousOffer: null, currentOffer: current, now: 200 });
  assert.equal(signal.state, "echo");
  assert.equal(signal.kind, "retailer_preparation");
});

test("non-leader cluster SKU remains an observation instead of a duplicate lifecycle alert", () => {
  const current = offer("out_of_stock", {
    evidence: [...structured("SKU-1"), { kind: "retailer_preparation_cluster", value: "prep_delta_reign", leaderOfferId: "off_other" }],
  });
  const signal = deriveSignal({ previousOffer: null, currentOffer: current, now: 200 });
  assert.equal(signal, null);
});

test("placeholder price can never Manifest from stock metadata alone", () => {
  const signal = deriveSignal({ previousOffer: null, currentOffer: offer("in_stock"), now: 200 });
  assert.notEqual(signal?.state, "manifested");
  assert.equal(signal?.state, "whisper");
  assert.equal(signal?.pricePence, null);
});

test("placeholder resolving to a real commercial price before availability is Echo evidence", () => {
  const previous = offer("out_of_stock", { pricePence: 1, firstSeenAt: 100, lastSeenAt: 180 });
  const current = offer("out_of_stock", { pricePence: 4999, firstSeenAt: 100, lastSeenAt: 200 });
  const signal = deriveSignal({ previousOffer: previous, currentOffer: current, now: 200 });
  assert.equal(signal.state, "echo");
  assert.ok(signal.evidence.some((entry) => entry.kind === "retailer_preparation_price_transition" && entry.value === "placeholder_to_commercial"));
});
