import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichShopsWithLocalStock,
  EXPECTED_STOCK_DISCLAIMER,
} from "../src/encounters/local-stock-intelligence.mjs";

const branch = {
  id: "loc-test",
  retailerId: "entertainer-uk",
  provider: "test_provider",
  providerPlaceId: "branch-1",
  name: "The Entertainer Test",
  address: "1 High Street, Teston",
  localStockStatus: "unknown",
};

function baseObservation(overrides = {}) {
  const now = Date.parse("2026-08-26T19:00:00Z");
  return {
    id: "event-test",
    kind: "echo",
    retailerId: "entertainer-uk",
    locationId: "loc-test",
    locationProvider: "test_provider",
    locationProviderId: "branch-1",
    locationName: "The Entertainer Test",
    productIdentityId: null,
    occurredAt: now,
    evidence: {
      localIntel: true,
      advisory: true,
      scope: "exact_branch_advisory",
      evidenceLevel: "inventory_preparation",
      sourceType: "official_retailer_page",
      sourceLabel: "Official retailer page",
      sourceUrl: "https://example.test/expected",
      rawProductTitle: "Pokemon TCG: Mega Forces Tin",
      expectedFrom: "2026-08-28T00:00:00Z",
      expectedTo: "2026-08-28T23:59:59Z",
      expectedLabel: "Expected 28 August",
      expiresAt: "2026-08-30T00:00:00Z",
      availabilityVerified: false,
    },
    ...overrides,
  };
}

test("expected branch intelligence projects to the simple Expected contract with advisory copy", () => {
  const now = Date.parse("2026-08-26T20:00:00Z");
  const [shop] = enrichShopsWithLocalStock([branch], [baseObservation()], now);

  assert.equal(shop.localAvailability.status, "expected");
  assert.equal(shop.localAvailability.expected.title, "Pokemon TCG: Mega Forces Tin");
  assert.equal(shop.localAvailability.expected.expectedLabel, "Expected 28 August");
  assert.equal(shop.localAvailability.expected.expectedFrom, "2026-08-28T00:00:00Z");
  assert.equal(shop.localAvailability.confirmed, null);
  assert.equal(shop.localAvailability.disclaimer, EXPECTED_STOCK_DISCLAIMER);
  assert.equal(shop.localStockProducts[0].localState, "expected");
  assert.equal(shop.localStockProducts[0].expectedLabel, "Expected 28 August");
  assert.equal(shop.localStockEvidence.verifiedBranchStock, false);
});

test("verified exact-branch official collection evidence projects to Confirmed", () => {
  const occurredAt = Date.parse("2026-08-26T19:30:00Z");
  const now = Date.parse("2026-08-26T20:00:00Z");
  const observation = baseObservation({
    id: "event-confirmed",
    kind: "manifested",
    productIdentityId: "prd_test_product",
    occurredAt,
    evidence: {
      localIntel: true,
      advisory: false,
      scope: "exact_branch",
      evidenceLevel: "official_collection",
      sourceType: "official_retailer_page",
      sourceLabel: "Official collection page",
      sourceUrl: "https://example.test/confirmed",
      rawProductTitle: "Pokemon TCG: Perfect Order Booster Pack",
      availabilityVerified: true,
      stockStatus: "collection_available",
      expiresAt: "2026-08-26T21:00:00Z",
    },
  });

  const [shop] = enrichShopsWithLocalStock([branch], [observation], now);

  assert.equal(shop.localAvailability.status, "confirmed");
  assert.equal(shop.localAvailability.confirmed.title, "Pokemon TCG: Perfect Order Booster Pack");
  assert.equal(shop.localAvailability.confirmed.productIdentityId, "prd_test_product");
  assert.equal(shop.localAvailability.expected, null);
  assert.equal(shop.localAvailability.disclaimer, null);
  assert.equal(shop.localStockProducts[0].localState, "confirmed");
  assert.equal(shop.localStockEvidence.verifiedBranchStock, true);
});

test("a later physical disappearance becomes Echo · No longer confirmed and projects to Unknown", () => {
  const now = Date.parse("2026-08-26T20:00:00Z");
  const manifested = baseObservation({
    id: "event-earlier-confirmed",
    kind: "manifested",
    productIdentityId: "prd_test_product",
    occurredAt: Date.parse("2026-08-26T19:00:00Z"),
    evidence: {
      localIntel: true,
      advisory: false,
      scope: "exact_branch",
      evidenceLevel: "official_collection",
      sourceType: "official_retailer_page",
      rawProductTitle: "Pokemon TCG: Perfect Order Booster Pack",
      availabilityVerified: true,
      stockStatus: "collection_available",
      expiresAt: "2026-08-26T21:00:00Z",
    },
  });
  const vanished = baseObservation({
    id: "event-later-unavailable",
    kind: "vanished",
    productIdentityId: "prd_test_product",
    occurredAt: Date.parse("2026-08-26T19:45:00Z"),
    evidence: {
      localIntel: true,
      advisory: false,
      scope: "exact_branch",
      evidenceLevel: "official_collection",
      sourceType: "official_retailer_page",
      rawProductTitle: "Pokemon TCG: Perfect Order Booster Pack",
      availabilityVerified: false,
      stockStatus: "collection_unavailable",
      expiresAt: "2026-08-26T21:00:00Z",
    },
  });

  const [shop] = enrichShopsWithLocalStock([branch], [manifested, vanished], now);

  assert.equal(shop.localAvailability.status, "unknown");
  assert.equal(shop.localAvailability.confirmed, null);
  assert.equal(shop.localAvailability.expected, null);
  assert.equal(shop.localStockProducts[0].localState, "unknown");
  assert.equal(shop.localStockProducts[0].lifecycleState, "echo");
  assert.equal(shop.localStockProducts[0].physicalEvidenceState, "expired");
});

test("a branch with no active evidence projects to Unknown", () => {
  const [shop] = enrichShopsWithLocalStock([branch], [], Date.parse("2026-08-26T20:00:00Z"));
  assert.deepEqual(shop.localAvailability, {
    status: "unknown",
    expected: null,
    confirmed: null,
    disclaimer: null,
  });
});
