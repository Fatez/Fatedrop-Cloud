import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalRetailerLocationQualityReview,
  reconcileLocationQuality,
} from "../src/encounters/canonical-retailer-locations.mjs";

const NOW = Date.parse("2026-09-01T12:00:00Z");

const rows = [
  { id: "tesco-parent", retailerId: "tesco-uk", provider: "official_retailer_directory", providerId: "watford-extra", name: "Tesco Extra Watford", address: "Watford", postcode: "WD17 1AA", latitude: 51.656, longitude: -0.395, storeFormat: "superstore", verification: "official_retailer_branch", updatedAt: 2000 },
  { id: "tesco-duplicate", retailerId: "tesco-uk", provider: "google_places", providerId: "duplicate-watford", name: "Tesco Extra Watford", address: "Watford", postcode: "WD17 1AA", latitude: 51.65601, longitude: -0.39501, storeFormat: "superstore", updatedAt: 1000 },
  { id: "tesco-pharmacy", retailerId: "tesco-uk", provider: "google_places", providerId: "watford-pharmacy", name: "Tesco Watford Pharmacy", address: "Tesco Extra Watford", postcode: "WD17 1AA", latitude: 51.65602, longitude: -0.39502, storeFormat: "pharmacy" },
  { id: "tesco-petrol", retailerId: "tesco-uk", provider: "google_places", providerId: "watford-petrol", name: "Tesco Watford Petrol Station", address: "Watford", postcode: "WD17 1AA", latitude: 51.6564, longitude: -0.3954, storeFormat: "petrol_station" },
  { id: "tesco-unknown-format", retailerId: "tesco-uk", provider: "google_places", providerId: "watford-unknown", name: "Tesco Watford", address: "Watford", postcode: "WD18 0AA", latitude: 51.66, longitude: -0.40, storeFormat: "unknown" },
  { id: "tesco-closed", retailerId: "tesco-uk", provider: "official_retailer_directory", providerId: "closed", name: "Tesco Old Watford", address: "Watford", postcode: "WD19 0AA", latitude: 51.67, longitude: -0.41, storeFormat: "superstore", operationalStatus: "closed" },
];

test("duplicate branches are resolved before child services choose a canonical parent", () => {
  const reconciled = reconcileLocationQuality(rows);
  const byId = new Map(reconciled.map((row) => [row.id, row]));
  assert.equal(byId.get("tesco-parent").visibilityClass, "eligible");
  assert.equal(byId.get("tesco-duplicate").visibilityClass, "excluded");
  assert.equal(byId.get("tesco-duplicate").visibilityReason, "duplicate");
  assert.equal(byId.get("tesco-duplicate").parentLocationId, "tesco-parent");
  assert.equal(byId.get("tesco-pharmacy").visibilityClass, "directory-only");
  assert.equal(byId.get("tesco-pharmacy").relationshipType, "child_service");
  assert.equal(byId.get("tesco-pharmacy").parentLocationId, "tesco-parent");
  assert.equal(byId.get("tesco-petrol").visibilityClass, "directory-only");
  assert.equal(byId.get("tesco-petrol").parentLocationId, "tesco-parent");
  assert.equal(byId.get("tesco-unknown-format").visibilityClass, "directory-only");
  assert.equal(byId.get("tesco-closed").visibilityClass, "excluded");
});

test("review report contains before/after counts, reasons, reconciliations, removed samples and fresh event-scoped Echo authority", async () => {
  const store = { async listRetailerLocations() { return rows; } };
  const review = await buildCanonicalRetailerLocationQualityReview(store, {
    now: NOW,
    echoEvents: [
      { locationId: "tesco-parent", sourceType: "official_retailer_page", exactBranch: true, chainWide: false, explicitTcgRelevance: true, productRelevant: true, productIdentityId: "pokemon:test-product", expiresAt: "2026-09-02T12:00:00Z" },
      { locationId: "tesco-unknown-format", sourceType: "official_retailer_page", exactBranch: true, explicitTcgRelevance: true, productRelevant: true, productIdentityId: "pokemon:test-product", expiresAt: "2026-09-02T12:00:00Z" },
      { locationId: "tesco-parent", sourceType: "official_retailer_page", exactBranch: true, explicitTcgRelevance: true, productRelevant: true, productIdentityId: "pokemon:expired", expiresAt: "2026-08-31T12:00:00Z" },
    ],
  });
  assert.equal(review.retailers.length, 1);
  const tesco = review.retailers[0];
  assert.equal(tesco.retailerId, "tesco-uk");
  assert.equal(tesco.rawTotal, 6);
  assert.equal(tesco.beforePublic, 5);
  assert.equal(tesco.afterPublic, 1);
  assert.equal(tesco.eligible, 1);
  assert.equal(tesco.directoryOnly, 3);
  assert.equal(tesco.excluded, 2);
  assert.equal(tesco.unresolved, 0);
  assert.equal(tesco.echoEligible, 1);
  assert.equal(tesco.deltaPublic, -4);
  assert.equal(review.echoEligibleBranchCount, 1);
  assert.ok(review.removedSamples.some((row) => row.id === "tesco-pharmacy"));
  assert.ok(review.reconciliations.some((row) => row.id === "tesco-duplicate" && row.relationshipType === "duplicate_of"));
  assert.ok(review.reconciliations.some((row) => row.id === "tesco-pharmacy" && row.parentLocationId === "tesco-parent"));
  assert.match(review.truthRule, /Raw locations, stock observations and lifecycle history remain unchanged/i);
  assert.match(review.truthRule, /without creating Vanished/i);
});
