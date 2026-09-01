import test from "node:test";
import assert from "node:assert/strict";

import {
  applyIndependentBranchEvidence,
  validateIndependentBranchEvidencePlan,
} from "../src/encounters/local-radar-independent-branch-evidence.mjs";
import {
  classifyLocationQuality,
  isEchoEligibleLocation,
} from "../src/encounters/local-radar-location-policy.mjs";

function parentPlan(overrides = {}) {
  return {
    version: "test",
    generatedAt: "2026-09-01T18:30:00.000Z",
    policy: {
      purpose: "branch_identity_corroboration_only",
      providerDiscoveryAloneCanonical: false,
      productionDatabaseTouched: false,
      stockStatus: "UNKNOWN",
      stockClaim: false,
      echoAuthorityCreated: false,
      runtimeLegacyCoordinateDriftMiles: 0.05,
    },
    parents: [{
      locationId: "tesco-parent",
      retailerId: "tesco-uk",
      provider: "openstreetmap",
      legacyName: "Tesco",
      legacyPostcode: "WD18 0AA",
      legacyLatitude: 51.6500,
      legacyLongitude: -0.4000,
      masterKey: "tesco-uk|WD180AA",
      masterPostcode: "WD18 0AA",
      masterBranch: "Tesco Watford Extra",
      masterLatitude: 51.6501,
      masterLongitude: -0.4001,
      storeFormat: "Tesco Extra",
      sourceType: "independent_branch_reconciliation",
      sourceProvider: "GEOLYTIX_RETAIL_POINTS",
      sourceFreshness: "GEOLYTIX_Geolytix_Retail_Points_2025_Q3",
      sourceCheckedDate: "2026-09-01",
      sourceUrl: "https://example.test/geolytix",
      matchType: "exact_postcode",
      distanceMiles: 0.01,
      verification: "independently_reconciled",
      evidenceSourceCountFloor: 2,
      stockStatus: "UNKNOWN",
      stockClaim: false,
      echoAuthority: false,
    }],
    duplicates: [{
      locationId: "tesco-duplicate",
      retailerId: "tesco-uk",
      provider: "openstreetmap",
      legacyName: "Tesco",
      legacyPostcode: "WD18 0AA",
      legacyLatitude: 51.65002,
      legacyLongitude: -0.40002,
      parentLocationId: "tesco-parent",
      masterKey: "tesco-uk|WD180AA",
      reason: "duplicate_independent_branch_reconciliation",
      stockStatus: "UNKNOWN",
      stockClaim: false,
      echoAuthority: false,
    }],
    ...overrides,
  };
}

function discoveryRow(overrides = {}) {
  return {
    id: "tesco-parent",
    retailerId: "tesco-uk",
    provider: "openstreetmap",
    providerId: "node-123",
    name: "Tesco",
    address: "Watford",
    postcode: "WD18 0AA",
    latitude: 51.6500,
    longitude: -0.4000,
    verification: "provider_discovered",
    retailerCategory: "supermarket",
    storeFormat: "unknown",
    operationalStatus: "open",
    tcgSellerStatus: "likely",
    tcgSellerConfidence: 60,
    identityStatus: "provisional",
    evidenceSourceCount: 1,
    openingDetails: { stockStatus: "unknown", stockClaim: false },
    ...overrides,
  };
}

test("independent evidence promotes only the matched discovery parent and preserves raw branch fields", () => {
  const plan = parentPlan();
  const input = discoveryRow();
  const before = structuredClone(input);
  const result = applyIndependentBranchEvidence([input], { plan });
  assert.equal(result.audit.parentsApplied, 1);
  const row = result.locations[0];
  assert.equal(row.verification, "independently_reconciled");
  assert.equal(row.identityStatus, "canonical");
  assert.equal(row.evidenceSourceCount, 2);
  assert.equal(row.storeFormat, "Tesco Extra");
  assert.equal(row.name, before.name);
  assert.equal(row.address, before.address);
  assert.equal(row.postcode, before.postcode);
  assert.equal(row.latitude, before.latitude);
  assert.equal(row.longitude, before.longitude);
  assert.equal(row.provider, before.provider);
  assert.deepEqual(input, before, "overlay must not mutate the raw input row");
  assert.equal(classifyLocationQuality(row).visibilityClass, "eligible");
  assert.equal(row.openingDetails.stockStatus, "unknown");
  assert.equal(row.openingDetails.stockClaim, false);
  assert.equal(isEchoEligibleLocation(row, {}, Date.now()), false, "branch identity must not create Echo authority");
});

test("provider discovery absent from the evidence plan stays provisional and unresolved", () => {
  const plan = parentPlan({ parents: [], duplicates: [] });
  const input = discoveryRow();
  const result = applyIndependentBranchEvidence([input], { plan });
  assert.equal(result.audit.untouched, 1);
  assert.equal(result.locations[0].verification, "provider_discovered");
  assert.equal(classifyLocationQuality(result.locations[0]).visibilityClass, "unresolved");
});

test("planned duplicate stays in the raw set but is excluded and points at its canonical parent", () => {
  const plan = parentPlan();
  const duplicate = discoveryRow({
    id: "tesco-duplicate",
    latitude: 51.65002,
    longitude: -0.40002,
  });
  const before = structuredClone(duplicate);
  const result = applyIndependentBranchEvidence([duplicate], { plan });
  assert.equal(result.audit.duplicatesApplied, 1);
  const row = result.locations[0];
  assert.equal(row.id, before.id);
  assert.equal(row.visibilityClass, "excluded");
  assert.equal(row.visibilityReason, "duplicate_independent_branch_reconciliation");
  assert.equal(row.parentLocationId, "tesco-parent");
  assert.equal(row.relationshipType, "duplicate_of");
  assert.deepEqual(duplicate, before, "duplicate overlay must not mutate raw history");
});

test("stronger official evidence is never demoted or replaced by the snapshot plan", () => {
  const plan = parentPlan();
  const official = discoveryRow({
    verification: "official_retailer_branch",
    identityStatus: "canonical",
    evidenceSourceCount: 3,
    openingDetails: { sourceType: "official_retailer_branch_page", stockStatus: "unknown", stockClaim: false },
  });
  const result = applyIndependentBranchEvidence([official], { plan });
  assert.equal(result.audit.skippedStrongerEvidence, 1);
  assert.deepEqual(result.locations[0], official);
});

test("retailer, provider, name, postcode or coordinate drift fails closed", () => {
  const plan = parentPlan();
  const variants = [
    discoveryRow({ retailerId: "argos-uk" }),
    discoveryRow({ provider: "google_places" }),
    discoveryRow({ name: "Tesco Pharmacy" }),
    discoveryRow({ postcode: "WD17 1AA" }),
    discoveryRow({ latitude: 51.70 }),
  ];
  for (const input of variants) {
    const result = applyIndependentBranchEvidence([input], { plan });
    assert.equal(result.audit.parentsApplied, 0);
    assert.equal(result.audit.skippedSnapshotDrift, 1);
    assert.equal(result.locations[0].verification, "provider_discovered");
  }
});

test("unsafe plans are rejected before any location can be promoted", () => {
  for (const patch of [
    { providerDiscoveryAloneCanonical: true },
    { productionDatabaseTouched: true },
    { stockStatus: "IN_STOCK" },
    { stockClaim: true },
    { echoAuthorityCreated: true },
  ]) {
    const plan = parentPlan({ policy: { ...parentPlan().policy, ...patch } });
    assert.throws(() => validateIndependentBranchEvidencePlan(plan), /fail-closed policy/);
  }
});
