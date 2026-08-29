import assert from "node:assert/strict";
import test from "node:test";

import { classifyRetailerPreparation, effectivePurchasable } from "../src/core/preparation-intelligence.mjs";
import { deriveRetailerPressure, retailerPressureEvidence, summarizeRetailerPressure } from "../src/core/retailer-pressure.mjs";

const NOW = 2_000_000_000;

function offer(overrides = {}) {
  return {
    offerId: "off:test",
    productId: "prd:test",
    retailerId: "smyths-uk",
    retailerName: "Smyths",
    retailerSku: "SKU-1",
    title: "Pokemon Test Elite Trainer Box",
    url: "https://example.test/product",
    stockStatus: "out_of_stock",
    stockConfidence: 0.8,
    stockQuantity: null,
    pricePence: 4999,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    evidence: [{ kind: "shopify_product", value: "structured" }],
    ...overrides,
  };
}

test("quiet catalogue discovery stays low pressure", () => {
  const pressure = deriveRetailerPressure({ currentOffer: offer(), now: NOW });
  assert.equal(pressure.score, 19);
  assert.equal(pressure.band, "quiet");
  assert.equal(pressure.attentionMode, "passive");
  assert.equal(pressure.suggestedScanCadenceSeconds, null);
});

test("correlated retailer preparation raises pressure without claiming stock", () => {
  const pressure = deriveRetailerPressure({
    currentOffer: offer({
      pricePence: 1,
      evidence: [
        { kind: "shopify_product", value: "structured" },
        { kind: "retailer_backend_exposed", value: "true" },
        { kind: "inventory_metadata", value: "present" },
        { kind: "queue_readiness", value: "present" },
        { kind: "security_readiness", value: "present" },
      ],
    }),
    now: NOW,
  });

  assert.equal(pressure.band, "high");
  assert.ok(pressure.score >= 60 && pressure.score < 80);
  assert.equal(pressure.attentionMode, "burst");
  assert.ok(pressure.fingerprint.includes("queue_readiness"));
});

test("pressure records a multi-signal acceleration fingerprint", () => {
  const previous = offer({
    firstSeenAt: NOW - 30,
    lastSeenAt: NOW - 30,
    pricePence: 1,
  });
  const current = offer({
    firstSeenAt: NOW - 30,
    evidence: [
      { kind: "shopify_product", value: "structured" },
      { kind: "queue_readiness", value: "present" },
      { kind: "security_readiness", value: "present" },
      { kind: "retailer_backend_exposed", value: "present" },
    ],
  });

  const pressure = deriveRetailerPressure({ previousOffer: previous, currentOffer: current, now: NOW });
  assert.ok(pressure.drivers.some((driver) => driver.name === "multi_evidence_acceleration"));
  assert.ok(pressure.drivers.some((driver) => driver.name === "placeholder_to_commercial_price"));
  assert.ok(pressure.delta > 0);
});

test("historical pressure decays when retailer behaviour cools", () => {
  const previous = offer({
    firstSeenAt: NOW - 1_000,
    lastSeenAt: NOW - 700,
    evidence: [
      { kind: "shopify_product", value: "structured" },
      { kind: "retailer_pressure", value: "80" },
    ],
  });
  const current = offer({ firstSeenAt: NOW - 1_000 });
  const pressure = deriveRetailerPressure({ previousOffer: previous, currentOffer: current, now: NOW });

  assert.ok(pressure.score < 80);
  assert.ok(pressure.score >= 20);
  assert.ok(pressure.delta < 0);
});

test("pressure evidence is explainable and scan hints never exceed burst safety floor", () => {
  const pressure = deriveRetailerPressure({
    currentOffer: offer({
      pricePence: 1,
      evidence: [
        { kind: "shopify_product", value: "structured" },
        { kind: "official_retailer_product_page", value: "verified" },
        { kind: "queue_readiness", value: "present" },
        { kind: "security_readiness", value: "present" },
        { kind: "retailer_backend_exposed", value: "present" },
        { kind: "inventory_metadata", value: "present" },
        {
          kind: "retailer_preparation_cluster",
          value: "prep:test",
          clusterLeader: true,
          leaderOfferId: "off:test",
        },
      ],
    }),
    now: NOW,
  });
  const evidence = retailerPressureEvidence(pressure, NOW);

  assert.equal(pressure.band, "critical");
  assert.ok(pressure.suggestedScanCadenceSeconds >= 60);
  assert.ok(evidence.some((entry) => entry.kind === "retailer_pressure" && entry.value === String(pressure.score)));
  assert.ok(evidence.some((entry) => entry.kind === "retailer_pressure_fingerprint"));
  assert.ok(evidence.some((entry) => entry.kind === "retailer_pressure_driver"));
});

test("pressure is advisory and cannot independently make an Echo", () => {
  const preparation = classifyRetailerPreparation({
    currentOffer: offer({
      evidence: [
        { kind: "shopify_product", value: "structured" },
        { kind: "retailer_pressure", value: "99" },
      ],
    }),
    now: NOW,
  });

  assert.equal(preparation.echoEligible, false);
  assert.ok(preparation.retailerPressure);
});

test("pressure metadata cannot bypass purchase verification", () => {
  const staged = offer({
    stockStatus: "in_stock",
    evidence: [
      { kind: "shopify_product", value: "structured" },
      { kind: "purchase_verification_required", value: "true" },
      { kind: "retailer_pressure", value: "100" },
    ],
  });
  assert.equal(effectivePurchasable(staged), false);

  const verified = {
    ...staged,
    evidence: [...staged.evidence, { kind: "add_to_cart_verified", value: "true" }],
  };
  assert.equal(effectivePurchasable(verified), true);
});

test("retailer summary selects strongest pressure and bounded fingerprints", () => {
  const summary = summarizeRetailerPressure([
    { score: 25, band: "watch", attentionMode: "standard", suggestedScanCadenceSeconds: 300, fingerprint: "catalogue" },
    { score: 72, band: "high", attentionMode: "burst", suggestedScanCadenceSeconds: 90, fingerprint: "queue+inventory" },
  ]);

  assert.equal(summary.max, 72);
  assert.equal(summary.band, "high");
  assert.equal(summary.attentionMode, "burst");
  assert.deepEqual(summary.fingerprints, ["queue+inventory"]);
});
