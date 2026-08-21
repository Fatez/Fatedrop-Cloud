import test from "node:test";
import assert from "node:assert/strict";
import { internationalUkAccessibleRetailers20260821 } from "../src/retailers/international-uk-accessible-2026-08-21.mjs";
import { retailerDiscoverySeeds, retailerDiscoveryStats } from "../src/retailers/retailer-discovery-network.mjs";
import { RETAILER_STATES, VERIFICATION_STATES, qualifyRetailer } from "../src/retailers/registry.mjs";
import { retailerToRuntimeConfig } from "../src/retailers/runtime.mjs";

test("retailer discovery network includes UK and first international UK-accessible batch", () => {
  assert.equal(retailerDiscoveryStats.ukCandidates, 28);
  assert.equal(retailerDiscoveryStats.internationalUkAccessibleCandidates, 3);
  assert.equal(retailerDiscoveryStats.uniqueCandidates, 31);
  assert.equal(retailerDiscoverySeeds.length, 31);
  assert.equal(new Set(retailerDiscoverySeeds.map((row) => row.id)).size, 31);
});

test("international candidates remain unverified candidates with UK shipping evidence", () => {
  for (const retailer of internationalUkAccessibleRetailers20260821) {
    assert.equal(retailer.countryCode, "JP");
    assert.equal(retailer.delivery.shipsToUk, true);
    assert.equal(retailer.state, RETAILER_STATES.CANDIDATE);
    assert.equal(retailer.verification, VERIFICATION_STATES.UNVERIFIED);
    assert.equal(qualifyRetailer(retailer).eligible, true);
  }
});

test("international candidate cannot become live runtime before landed-cost support", () => {
  const candidate = internationalUkAccessibleRetailers20260821[0];
  const monitored = { ...candidate, state: RETAILER_STATES.MONITORED };
  assert.throws(() => retailerToRuntimeConfig(monitored), /international FX.*landed-cost conversion/i);
});
