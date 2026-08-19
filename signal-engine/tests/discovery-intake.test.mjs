import test from "node:test";
import assert from "node:assert/strict";
import { ingestDiscoveryBatch } from "../src/retailers/discovery-intake.mjs";
import { DISCOVERY_SOURCE_TYPES, discoverySourcePolicy } from "../src/retailers/discovery-sources.mjs";
import { buildQualificationQueue } from "../src/retailers/qualification-queue.mjs";

test("directory discovery can identify candidates but cannot assert stock or verification", () => {
  const policy = discoverySourcePolicy[DISCOVERY_SOURCE_TYPES.PUBLIC_DIRECTORY];
  assert.equal(policy.mayDiscoverRetailer, true);
  assert.equal(policy.mayAssertStock, false);
  assert.equal(policy.mayAssertPrice, false);
  assert.equal(policy.mayAssertVerification, false);
});

test("batch intake rejects invalid URLs and deduplicates repeated retailer sightings", () => {
  const result = ingestDiscoveryBatch([
    { name: "Example Cards", websiteUrl: "https://www.examplecards.co.uk", catalogueUrl: "https://examplecards.co.uk/pokemon", tcgs: ["pokemon"] },
    { name: "Example Cards UK", websiteUrl: "https://examplecards.co.uk/", tcgs: ["pokemon", "one-piece"] },
    { name: "Broken", websiteUrl: "not-a-url" },
  ], { type: DISCOVERY_SOURCE_TYPES.PUBLIC_DIRECTORY, name: "Example directory", url: "https://directory.example/" });
  assert.equal(result.received, 3);
  assert.equal(result.accepted, 2);
  assert.equal(result.unique, 1);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.candidates[0].tcgs.sort(), ["one-piece", "pokemon"]);
  assert.equal(result.candidates[0].verification, "unverified");
});

test("qualification queue prioritises operational onboarding without creating a consumer ranking", () => {
  const intake = ingestDiscoveryBatch([
    { name: "National Cards", websiteUrl: "https://national.example", catalogueUrl: "https://national.example/cards", retailerClass: "national", physicalLocations: 30 },
    { name: "Indie Cards", websiteUrl: "https://indie.example", catalogueUrl: "https://indie.example/cards", retailerClass: "independent" },
  ], { type: DISCOVERY_SOURCE_TYPES.MANUAL_RESEARCH, name: "Research" });
  const result = buildQualificationQueue(intake.candidates);
  assert.equal(result.queue.length, 2);
  assert.equal(result.queue[0].name, "National Cards");
  assert.ok(result.queue[0].operationalPriority > result.queue[1].operationalPriority);
  assert.equal(result.queue[0].candidate.verification, "unverified");
});
