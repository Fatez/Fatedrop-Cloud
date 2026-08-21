import test from "node:test";
import assert from "node:assert/strict";
import { ukRetailerDirectoryLeads } from "../src/retailers/uk-discovery-leads.mjs";
import { ukRetailerDiscoveryFunnel, ukRetailerDiscoveryFunnelStats } from "../src/retailers/uk-discovery-funnel.mjs";

test("UK retailer discovery funnel exceeds 100 unique prospects without inflating monitored coverage", () => {
  assert.ok(ukRetailerDirectoryLeads.length >= 80, "expected a broad raw directory lead pool");
  assert.ok(ukRetailerDiscoveryFunnelStats.discoveredUnique >= 100, "discovery funnel should exceed 100 unique retailer prospects");
  assert.equal(ukRetailerDiscoveryFunnelStats.websiteQualifiedCandidates, 28);
  assert.equal(ukRetailerDiscoveryFunnelStats.verifiedCandidates, 0);
  assert.equal(ukRetailerDiscoveryFunnelStats.monitoredCandidates, 0);
  assert.equal(
    ukRetailerDiscoveryFunnelStats.discoveredUnique,
    ukRetailerDiscoveryFunnelStats.websiteQualifiedCandidates + ukRetailerDiscoveryFunnelStats.rawLeadsAwaitingWebsiteQualification,
  );
});

test("raw directory leads never masquerade as retailer-owned website or stock evidence", () => {
  for (const lead of ukRetailerDirectoryLeads) {
    assert.equal(lead.status, "lead");
    assert.equal(lead.websiteUrl, null);
    assert.ok(lead.sourceUrl.startsWith("https://"));
    assert.deepEqual(lead.tcgs, ["pokemon"]);
  }
  assert.equal(ukRetailerDiscoveryFunnel.some((row) => row.status === "lead" && row.websiteUrl), false);
});
