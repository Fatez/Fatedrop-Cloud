import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("unknown retailers remain candidates and language is never used as a market or seller rule", () => {
  const policy = normalizeLocationPolicy({
    retailerId: "new-independent",
    name: "English name for an Asian set specialist",
    language: "English",
  });
  assert.equal(policy.retailerCategory, "other");
  assert.equal(policy.retailerGroup, "unclassified");
  assert.equal(policy.tcgSellerStatus, "candidate");
  assert.equal(policy.tcgSellerConfidence, 0);
});

test("unknown or invalid retailer groups remain unclassified rather than guessed independent", () => {
  assert.equal(normalizeLocationPolicy({ retailerId: "unknown" }).retailerGroup, "unclassified");
  assert.equal(normalizeLocationPolicy({ retailerId: "unknown", retailerGroup: "made-up" }).retailerGroup, "unclassified");
});

test("closed, excluded, and conflicted locations fail closed", () => {
  assert.equal(isRadarEligibleLocation({ retailerId: "smyths-uk", operationalStatus: "closed" }), false);
  assert.equal(isRadarEligibleLocation({ retailerId: "smyths-uk", tcgSellerStatus: "excluded" }), false);
  assert.equal(isRadarEligibleLocation({ retailerId: "smyths-uk", identityStatus: "conflicted" }), false);
});

test("public evidence copy never claims exact branch stock", () => {
  const evidence = publicLocationEvidence({ retailerId: "total-cards", evidenceSourceCount: 2 });
  assert.equal(evidence.pokemonSeller, "verified");
  assert.equal(evidence.sourceCount, 2);
  assert.match(evidence.caveat, /exact stock is still unknown until Manifested/i);
});
