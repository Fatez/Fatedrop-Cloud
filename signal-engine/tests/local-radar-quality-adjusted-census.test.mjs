import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQualityAdjustedLocalRadarCensus,
  hasTrustedCanonicalParentEvidence,
} from "../src/encounters/local-radar-quality-adjusted-census.mjs";

const NOW = Date.parse("2026-09-01T12:00:00Z");

const rows = [
  {
    id: "tesco-parent",
    retailerId: "tesco-uk",
    provider: "tesco_official_directory",
    providerId: "watford-extra",
    name: "Tesco Extra Watford",
    address: "Watford",
    postcode: "WD17 1AA",
    latitude: 51.656,
    longitude: -0.395,
    storeFormat: "superstore",
    verification: "official_retailer_branch",
    identityStatus: "canonical",
  },
  {
    id: "tesco-duplicate",
    retailerId: "tesco-uk",
    provider: "google_places",
    providerId: "duplicate-watford",
    name: "Tesco Extra Watford",
    address: "Watford",
    postcode: "WD17 1AA",
    latitude: 51.65601,
    longitude: -0.39501,
    storeFormat: "superstore",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "tesco-pharmacy",
    retailerId: "tesco-uk",
    provider: "google_places",
    providerId: "watford-pharmacy",
    name: "Tesco Watford Pharmacy",
    address: "Tesco Extra Watford",
    postcode: "WD17 1AA",
    latitude: 51.65602,
    longitude: -0.39502,
    storeFormat: "pharmacy",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "tesco-provisional",
    retailerId: "tesco-uk",
    provider: "google_places",
    providerId: "watford-provisional",
    name: "Tesco Watford",
    address: "Watford",
    postcode: "WD18 0AA",
    latitude: 51.66,
    longitude: -0.40,
    storeFormat: "unknown",
    verification: "provider_discovered",
    identityStatus: "provisional",
  },
  {
    id: "tesco-weak-discovery",
    retailerId: "tesco-uk",
    provider: "google_places",
    providerId: "watford-weak",
    name: "Tesco Watford High Street",
    address: "Watford",
    postcode: "WD17 2AA",
    latitude: 51.658,
    longitude: -0.397,
    storeFormat: "superstore",
    verification: "provider_discovered",
  },
  {
    id: "entertainer-parent",
    retailerId: "entertainer-uk",
    provider: "entertainer_official_directory",
    providerId: "https://www.thetoyshop.com/store/watford",
    name: "The Entertainer Watford",
    address: "Watford",
    postcode: "WD17 2UB",
    latitude: 51.655,
    longitude: -0.397,
    storeFormat: "unknown",
    verification: "official_retailer_branch",
    identityStatus: "canonical",
    openingDetails: { sourceType: "official_retailer_branch_page" },
  },
  {
    id: "tesco-closed",
    retailerId: "tesco-uk",
    provider: "tesco_official_directory",
    providerId: "closed",
    name: "Tesco Old Watford",
    address: "Watford",
    postcode: "WD19 0AA",
    latitude: 51.67,
    longitude: -0.41,
    storeFormat: "superstore",
    operationalStatus: "closed",
    verification: "official_retailer_branch",
    identityStatus: "canonical",
  },
];

test("quality-adjusted denominator is independently evidence-derived and raw before/after remains visible", () => {
  const census = buildQualityAdjustedLocalRadarCensus(rows, {
    now: NOW,
    echoEvents: [
      {
        locationId: "tesco-parent",
        sourceType: "official_retailer_page",
        exactBranch: true,
        chainWide: false,
        explicitTcgRelevance: true,
        productRelevant: true,
        productIdentityId: "pokemon:test-product",
        expiresAt: "2026-09-02T12:00:00Z",
      },
    ],
  });

  assert.equal(census.totals.rawTotal, 7);
  assert.equal(census.totals.publicBefore, 6);
  assert.equal(census.totals.eligibleAfter, 2);
  assert.equal(census.totals.rawPublicDelta, -4);
  assert.equal(census.totals.rawSurvivalPct, 1 / 3);

  assert.equal(census.totals.uniqueCanonicalParentTotal, 2);
  assert.equal(census.totals.retainedCanonicalParentTotal, 2);
  assert.equal(census.totals.qualityAdjustedPublicDelta, 0);
  assert.equal(census.totals.qualityAdjustedSurvivalPct, 1);
  assert.equal(census.totals.echoEligibleAfter, 1);
  assert.ok(census.totals.echoEligibleAfter < census.totals.eligibleAfter);

  assert.equal(census.samples.lostCanonicalParents.length, 0);
  assert.equal(census.samples.obviousNoiseEligible.length, 0);
  assert.equal(census.samples.provisionalEligible.length, 0);
  assert.equal(census.samples.weakDiscoveryEligible.length, 0);
  assert.match(census.diagnostics.trustedCanonicalParentRule, /never uses visibilityClass=eligible/i);
  assert.match(census.diagnostics.rawMetricRule, /Raw survival is preserved/i);
  assert.equal(census.diagnostics.historyMutation, false);
});

test("trusted parent evidence requires branch-level provenance and never trusts chain name alone", () => {
  assert.equal(hasTrustedCanonicalParentEvidence(rows[0]), true);
  assert.equal(hasTrustedCanonicalParentEvidence(rows[1]), false);
  assert.equal(hasTrustedCanonicalParentEvidence(rows[2]), false);
  assert.equal(hasTrustedCanonicalParentEvidence(rows[3]), false);
  assert.equal(hasTrustedCanonicalParentEvidence(rows[4]), false);
  assert.equal(hasTrustedCanonicalParentEvidence(rows[5]), true);
  assert.equal(hasTrustedCanonicalParentEvidence(rows[6]), false);

  assert.equal(hasTrustedCanonicalParentEvidence({
    id: "reviewed-google",
    retailerId: "tesco-uk",
    provider: "google_places",
    providerId: "reviewed",
    name: "Tesco Reviewed Branch",
    postcode: "WD17 9ZZ",
    latitude: 51.65,
    longitude: -0.39,
    storeFormat: "superstore",
    verification: "source_verified",
    identityStatus: "canonical",
    evidenceSourceCount: 2,
  }), false);
});
