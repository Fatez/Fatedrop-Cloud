import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLocationQuality,
  isEchoEligibleLocation,
  isRadarEligibleLocation,
  normalizeLocationPolicy,
  publicLocationEvidence,
} from "../src/encounters/local-radar-location-policy.mjs";

test("Cloud owns retailer category and seller evidence independently from stock", () => {
  const policy = normalizeLocationPolicy({ retailerId: "smyths-uk" });
  assert.equal(policy.retailerCategory, "toy_store");
  assert.equal(policy.tcgSellerStatus, "likely");
  assert.equal(policy.tcgSellerConfidence, 85);
  assert.equal(policy.operationalStatus, "unknown");
  assert.equal("localStockStatus" in policy, false);
});

test("unknown retailers remain directory-only candidates and language is never used as a market or seller rule", () => {
  const location = {
    retailerId: "new-independent",
    name: "English name for an Asian set specialist",
    language: "English",
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
    const quality = classifyLocationQuality({ retailerId: "tesco-uk", name });
    assert.equal(quality.visibilityClass, "excluded");
    assert.equal(quality.reason, reason);
    assert.equal(isRadarEligibleLocation({ retailerId: "tesco-uk", name }), false);
  }
});

test("chain-level likely status can support a clean public branch but never Echo without explicit branch TCG evidence", () => {
  const branch = { retailerId: "tesco-uk", name: "Tesco Extra Watford" };
  assert.equal(classifyLocationQuality(branch).visibilityClass, "eligible");
  assert.equal(isEchoEligibleLocation(branch), false);
  assert.equal(isEchoEligibleLocation(branch, {
    sourceType: "official_retailer_page",
    exactBranch: true,
    explicitTcgRelevance: true,
  }), true);
});

test("explicit TCG evidence cannot make a child service Echo eligible", () => {
  const pharmacy = { retailerId: "tesco-uk", name: "Tesco Watford Pharmacy" };
  assert.equal(isEchoEligibleLocation(pharmacy, {
    sourceType: "official_retailer_page",
    exactBranch: true,
    explicitTcgRelevance: true,
  }), false);
});

test("verified specialist branch can be Echo eligible from stored branch evidence without claiming stock", () => {
  const branch = { retailerId: "total-cards", name: "Total Cards" };
  assert.equal(isEchoEligibleLocation(branch), true);
  const evidence = publicLocationEvidence({ ...branch, evidenceSourceCount: 2 });
  assert.equal(evidence.pokemonSeller, "verified");
  assert.equal(evidence.sourceCount, 2);
  assert.equal(evidence.visibilityClass, "eligible");
  assert.equal(evidence.echoEligibleFromStoredEvidence, true);
  assert.match(evidence.caveat, /exact stock is still unknown until Manifested/i);
});
