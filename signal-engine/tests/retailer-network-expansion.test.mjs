import test from "node:test";
import assert from "node:assert/strict";
import { buildQualificationQueue } from "../src/retailers/qualification-queue.mjs";
import { RETAILER_STATES, VERIFICATION_STATES } from "../src/retailers/registry.mjs";
import { ukRetailerExpansion20260821 } from "../src/retailers/uk-discovery-expansion-2026-08-21.mjs";
import { ukRetailerDiscoverySeeds, ukRetailerDiscoveryStats } from "../src/retailers/uk-discovery-network.mjs";

test("UK discovery network aggregates the first expansion batch without duplicates", () => {
  assert.equal(ukRetailerDiscoveryStats.foundation, 10);
  assert.equal(ukRetailerDiscoveryStats.expansion20260821, 18);
  assert.equal(ukRetailerDiscoveryStats.unique, 28);
  assert.equal(ukRetailerDiscoverySeeds.length, 28);
  const ids = ukRetailerDiscoverySeeds.map((retailer) => retailer.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const required of ["go-cards-uk", "buy-any-cards", "card-goblin", "phantom-cards-uk", "sealcrest", "shuffled"]) {
    assert.ok(ids.includes(required), `missing expansion retailer ${required}`);
  }
});

test("new discovery candidates cannot silently become verified or monitored", () => {
  for (const retailer of ukRetailerExpansion20260821) {
    assert.equal(retailer.state, RETAILER_STATES.CANDIDATE, `${retailer.id} must start as candidate`);
    assert.equal(retailer.verification, VERIFICATION_STATES.UNVERIFIED, `${retailer.id} must start unverified`);
  }
  const report = buildQualificationQueue(ukRetailerDiscoverySeeds);
  assert.equal(report.coverage.total, 28);
  assert.equal(report.coverage.verified, 0);
  assert.equal(report.coverage.monitored, 0);
  assert.equal(report.queue.some((row) => row.readyForMonitoring), false);
});

test("Shopify discovery records keep feeds unapproved until qualification", () => {
  const shopify = ukRetailerExpansion20260821.filter((retailer) => retailer.adapterType === "shopify");
  assert.equal(shopify.length, 14);
  for (const retailer of shopify) {
    assert.equal(retailer.catalogue.feedApproved, false, `${retailer.id} feed must not be auto-approved`);
    assert.match(retailer.catalogue.feedUrl, /\/products\.json\?limit=250$/);
    assert.ok(retailer.catalogue.platformEvidence.includes("public-site-footer:powered-by-shopify"));
  }
});
