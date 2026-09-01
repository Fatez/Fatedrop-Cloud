import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLocalStockObservation } from "../src/encounters/local-stock-store.mjs";
import { enrichShopsWithLocalStock } from "../src/encounters/local-stock-intelligence.mjs";
import { prioritizeLocalRadarShops } from "../src/encounters/local-radar-ranking.mjs";

const base = {
  retailerId: "entertainer-uk",
  locationId: "branch-bluewater",
  productIdentityId: "product-30th-etb",
  occurredAt: 1789462800,
};

test("legacy local Manifested input is canonicalized to Echo · verified", () => {
  const row = normalizeLocalStockObservation({
    ...base,
    kind: "manifested",
    evidence: { evidenceLevel: "official_branch", sourceType: "official_retailer_app", stockStatus: "in_stock", availabilityVerified: true },
  });
  assert.equal(row.kind, "echo");
  assert.equal(row.evidence.alertChannel, "echo");
  assert.equal(row.evidence.availabilityScope, "physical_branch");
  assert.equal(row.evidence.physicalEvidenceState, "verified");
});

test("legacy local Vanished input is canonicalized to Echo · expired", () => {
  const row = normalizeLocalStockObservation({
    ...base,
    kind: "vanished",
    evidence: { evidenceLevel: "official_branch", sourceType: "official_retailer_app", stockStatus: "out_of_stock" },
  });
  assert.equal(row.kind, "echo");
  assert.equal(row.evidence.physicalEvidenceState, "expired");
});

test("allocation evidence stays Echo · expected and cannot masquerade as verified", () => {
  const row = normalizeLocalStockObservation({
    ...base,
    productIdentityId: null,
    kind: "echo",
    evidence: { evidenceLevel: "inventory_preparation", sourceType: "official_retailer_page", expectedLabel: "Releasing 16 September" },
  });
  assert.equal(row.kind, "echo");
  assert.equal(row.evidence.physicalEvidenceState, "expected");
});

test("verified physical Echo projects as confirmed and outranks expected by truth before distance", () => {
  const now = Date.now();
  const verified = normalizeLocalStockObservation({
    retailerId: "entertainer-uk", locationId: "far", productIdentityId: "product-30th-etb", kind: "manifested", occurredAt: now,
    evidence: { evidenceLevel: "official_branch", sourceType: "official_retailer_app", stockStatus: "in_stock", availabilityVerified: true, expiresAt: new Date(now + 3600000).toISOString() },
  });
  const expected = normalizeLocalStockObservation({
    retailerId: "entertainer-uk", locationId: "near", productIdentityId: null, kind: "echo", occurredAt: now,
    evidence: { evidenceLevel: "inventory_preparation", sourceType: "official_retailer_page", expectedLabel: "16 September", expiresAt: new Date(now + 3600000).toISOString() },
  });
  const shops = enrichShopsWithLocalStock([
    { id: "far", retailerId: "entertainer-uk", provider: "canonical", providerPlaceId: null, name: "Far", distanceMiles: 12 },
    { id: "near", retailerId: "entertainer-uk", provider: "canonical", providerPlaceId: null, name: "Near", distanceMiles: 1 },
  ], [
    { ...verified, locationProvider: "canonical", locationName: "Far" },
    { ...expected, locationProvider: "canonical", locationName: "Near" },
  ], now);
  const ranked = prioritizeLocalRadarShops(shops);
  assert.equal(ranked[0].id, "far");
  assert.equal(ranked[0].localStockEvidence.lifecycleState, "echo");
  assert.equal(ranked[0].localStockEvidence.physicalEvidenceState, "verified");
  assert.equal(ranked[1].localStockEvidence.physicalEvidenceState, "expected");
});

test("Expected allocation outranks Reported physical intelligence before distance", () => {
  const ranked = prioritizeLocalRadarShops([
    { id: "reported-near", name: "Reported Near", distanceMiles: 1, localStockEvidence: { physicalEvidenceState: "reported" } },
    { id: "expected-far", name: "Expected Far", distanceMiles: 15, localStockEvidence: { physicalEvidenceState: "expected" } },
  ]);
  assert.deepEqual(ranked.map((shop) => shop.id), ["expected-far", "reported-near"]);
});
