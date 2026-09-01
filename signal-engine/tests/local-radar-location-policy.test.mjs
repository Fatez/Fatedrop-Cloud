import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLocationQuality,
  isEchoEligibleLocation,
  isRadarEligibleLocation,
  normalizeLocationPolicy,
  publicLocationEvidence,
} from "../src/encounters/local-radar-location-policy.mjs";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const ACTIVE_UNTIL = "2026-09-02T12:00:00Z";
const EXPIRED_AT = "2026-08-31T12:00:00Z";

function activeEchoEvidence(overrides = {}) {
  return {
    sourceType: "official_retailer_page",
    exactBranch: true,
    chainWide: false,
    explicitTcgRelevance: true,
    productRelevant: true,
    rawProductTitle: "Pokémon TCG test product",
    expiresAt: ACTIVE_UNTIL,
    ...overrides,
  };
}

test("Cloud owns retailer category and seller evidence independently from stock", () => {
  const policy = normalizeLocationPolicy({ retailerId: "smyths-uk" });
  assert.equal(policy.retailerCategory, "toy_store");
  assert.equal(policy.tcgSellerStatus, "likely");
  assert.equal(policy.tcgSellerConfidence, 85);
  assert.equal(policy.operationalStatus, "unknown");
  assert.equal("localStockStatus" in policy, false);
});

test("unknown formats and unknown retailers fail closed to directory-only", () => {
  const knownRetailerUnknownFormat = { retailerId: "smyths-uk", name: "Smyths Stevenage" };
  assert.equal(classifyLocationQuality(knownRetailerUnknownFormat).visibilityClass, "directory-only");
  assert.equal(classifyLocationQuality(knownRetailerUnknownFormat).reason, "store_format_unknown");

  const location = {
    retailerId: "new-independent",
    name: "English name for an Asian set specialist",
    language: "English",
    storeFormat: "specialist",
  };
  const policy = normalizeLocationPolicy(location);
  assert.equal(policy.retailerCategory, "other");
  assert.equal(policy.retailerGroup, "unclassified");
  assert.equal(policy.tcgSellerStatus, "candidate");
  assert.equal(policy.tcgSellerConfidence, 0);
  assert.equal(classifyLocationQuality(location).visibilityClass, "directory-only");
  assert.equal(isRadarEligibleLocation(location), false);
});

test("unknown or invalid retailer groups remain unclassified rather than guessed independent", () => {
  assert.equal(normalizeLocationPolicy({ retailerId: "unknown" }).retailerGroup, "unclassified");
  assert.equal(normalizeLocationPolicy({ retailerId: "unknown", retailerGroup: "made-up" }).retailerGroup, "unclassified");
});

test("closed, excluded, and conflicted locations fail closed", () => {
  assert.equal(isRadarEligibleLocation({ retailerId: "smyths-uk", operationalStatus: "closed" }), false);
  assert.equal(classifyLocationQuality({ retailerId: "smyths-uk", operationalStatus: "closed" }).visibilityClass, "excluded");
  assert.equal(isRadarEligibleLocation({ retailerId: "smyths-uk", tcgSellerStatus: "excluded" }), false);
  assert.equal(isRadarEligibleLocation({ retailerId: "smyths-uk", identityStatus: "conflicted" }), false);
  assert.equal(classifyLocationQuality({ retailerId: "smyths-uk", identityStatus: "conflicted" }).visibilityClass, "unresolved");
});

test("pharmacies, petrol stations, lockers, and service counters never appear as public branches", () => {
  const examples = [
    ["Tesco Watford Pharmacy", "pharmacy"],
    ["Tesco Extra Petrol Station", "petrol_station"],
    ["Tesco Parcel Locker", "locker"],
    ["Tesco Customer Service Counter", "service_counter"],
  ];
  for (const [name, reason] of examples) {
    const quality = classifyLocationQuality({ retailerId: "tesco-uk", name, storeFormat: "supermarket" });
    assert.equal(quality.visibilityClass, "excluded");
    assert.equal(quality.reason, reason);
    assert.equal(isRadarEligibleLocation({ retailerId: "tesco-uk", name, storeFormat: "supermarket" }), false);
  }
});

test("chain-level likely status can support a clean public branch but cannot create Echo by itself", () => {
  const branch = { retailerId: "tesco-uk", name: "Tesco Extra Watford", storeFormat: "supermarket" };
  assert.equal(classifyLocationQuality(branch).visibilityClass, "eligible");
  assert.equal(isEchoEligibleLocation(branch, {}, NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence(), NOW), true);
});

test("Echo requires exact branch, product relevance, authoritative source and fresh evidence", () => {
  const branch = { retailerId: "entertainer-uk", name: "The Entertainer Watford", storeFormat: "toy_store" };
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence({ exactBranch: false }), NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence({ productRelevant: false, rawProductTitle: null }), NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence({ sourceType: "generic_chain_article" }), NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence({ chainWide: true }), NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence({ expiresAt: EXPIRED_AT }), NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence(), NOW), true);
});

test("explicit TCG evidence cannot make a child service Echo eligible", () => {
  const pharmacy = { retailerId: "tesco-uk", name: "Tesco Watford Pharmacy", storeFormat: "pharmacy" };
  assert.equal(isEchoEligibleLocation(pharmacy, activeEchoEvidence(), NOW), false);
});

test("verified specialist status supports public branch relevance but never permanent Echo authority", () => {
  const branch = { retailerId: "total-cards", name: "Total Cards", storeFormat: "specialist_tcg" };
  assert.equal(isRadarEligibleLocation(branch), true);
  assert.equal(isEchoEligibleLocation(branch, {}, NOW), false);
  assert.equal(isEchoEligibleLocation(branch, activeEchoEvidence({ explicitTcgRelevance: false }), NOW), true);

  const evidence = publicLocationEvidence({ ...branch, evidenceSourceCount: 2 });
  assert.equal(evidence.pokemonSeller, "verified");
  assert.equal(evidence.sourceCount, 2);
  assert.equal(evidence.visibilityClass, "eligible");
  assert.match(evidence.caveat, /exact stock is still unknown until Manifested/i);
});
