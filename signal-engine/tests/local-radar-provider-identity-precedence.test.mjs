import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLocationQuality,
  isEchoEligibleLocation,
  isRadarEligibleLocation,
  normalizeLocationPolicy,
} from "../src/encounters/local-radar-location-policy.mjs";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const ACTIVE_ECHO = {
  sourceType: "official_retailer_page",
  exactBranch: true,
  chainWide: false,
  explicitTcgRelevance: true,
  productRelevant: true,
  productIdentityId: "pokemon:test-product",
  expiresAt: "2026-09-02T12:00:00Z",
};

function discovery(overrides = {}) {
  return {
    id: "tesco-discovery",
    retailerId: "tesco-uk",
    provider: "openstreetmap",
    providerId: "osm:123",
    name: "Tesco Example",
    address: "Example Street",
    postcode: "WD17 1AA",
    latitude: 51.656,
    longitude: -0.395,
    storeFormat: "supermarket",
    verification: "provider_discovered",
    identityStatus: "canonical",
    ...overrides,
  };
}

test("provider discovery claiming canonical is forced provisional and unresolved", () => {
  const row = discovery();
  const before = structuredClone(row);
  const policy = normalizeLocationPolicy(row);
  const quality = classifyLocationQuality(row);

  assert.equal(policy.identityStatus, "provisional");
  assert.equal(quality.visibilityClass, "unresolved");
  assert.equal(quality.reason, "provisional_identity");
  assert.equal(isRadarEligibleLocation(row), false);
  assert.equal(isEchoEligibleLocation(row, ACTIVE_ECHO, NOW), false);
  assert.deepEqual(row, before, "classification must not mutate the raw row");
});

test("provider discovery plus stronger official branch evidence may remain canonical", () => {
  const row = discovery({
    provider: "entertainer_official_directory",
    verification: "provider_discovered",
    openingDetails: {
      sourceType: "official_retailer_branch_page",
      sourceUrl: "https://www.thetoyshop.com/store/example",
    },
  });
  const policy = normalizeLocationPolicy(row);
  assert.equal(policy.identityStatus, "canonical");
  assert.equal(classifyLocationQuality(row).visibilityClass, "eligible");
});

test("provider discovery plus explicit independent reconciliation may remain canonical", () => {
  const row = discovery({
    verification: "provider_discovered",
    canonicalReconciled: true,
    evidenceSourceCount: 2,
  });
  const policy = normalizeLocationPolicy(row);
  assert.equal(policy.identityStatus, "canonical");
  assert.equal(classifyLocationQuality(row).visibilityClass, "eligible");
});

test("discovery-only visibility removal does not create Echo authority or mutate stock/history fields", () => {
  const row = discovery({
    openingDetails: {
      stockStatus: "unknown",
      stockClaim: false,
      lifecycleHistory: ["echo:historical"],
    },
  });
  const before = JSON.stringify(row);

  assert.equal(isRadarEligibleLocation(row), false);
  assert.equal(isEchoEligibleLocation(row, ACTIVE_ECHO, NOW), false);
  assert.equal(JSON.stringify(row), before);
  assert.deepEqual(row.openingDetails.lifecycleHistory, ["echo:historical"]);
  assert.equal(row.openingDetails.stockStatus, "unknown");
  assert.equal(row.openingDetails.stockClaim, false);
});
