import assert from "node:assert/strict";
import test from "node:test";

import {
  CURATED_INCOMING_INTEL,
  reconcileCuratedIncomingIntel,
  targetBranchMatchesLocation,
} from "../src/encounters/curated-incoming-intel-reconcile.mjs";

function entry(overrides = {}) {
  return {
    id: "test-incoming",
    retailerId: "entertainer-uk",
    kind: "echo",
    rawProductTitle: "Pokémon TCG: Test Tin",
    sourceType: "official_retailer_page",
    sourceId: "official:test",
    sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
    sourceLabel: "Official retailer page",
    observedAt: "2026-08-26T15:45:00+01:00",
    expectedFrom: "2026-08-28T00:00:00+01:00",
    expectedTo: "2026-08-28T23:59:59+01:00",
    expectedLabel: "Expected 28 August",
    expiresAt: "2026-08-29T23:59:59+01:00",
    confidence: 0.68,
    evidenceBasis: "Official retailer release notice with named participating stores.",
    note: "Check store before travelling.",
    targetBranches: ["The Entertainer Watford", "The Entertainer Basildon"],
    ...overrides,
  };
}

const LOCATIONS = [
  { id: "loc-watford", retailerId: "entertainer-uk", name: "The Entertainer", address: "Atria Watford, Watford", postcode: "WD17 2UB" },
  { id: "loc-basildon", retailerId: "entertainer-uk", name: "The Entertainer Basildon", address: "Eastgate, Basildon", postcode: "SS14 1AF" },
  { id: "loc-other", retailerId: "entertainer-uk", name: "The Entertainer", address: "High Street, Oxford", postcode: "OX1 1AA" },
  { id: "loc-tesco", retailerId: "tesco-uk", name: "Tesco Extra Watford", address: "Watford", postcode: "WD17 1AA" },
];

test("branch target matching is retailer-agnostic text matching and requires every target location term", () => {
  assert.equal(targetBranchMatchesLocation("The Entertainer Watford", LOCATIONS[0]), true);
  assert.equal(targetBranchMatchesLocation("The Entertainer Basildon", LOCATIONS[1]), true);
  assert.equal(targetBranchMatchesLocation("The Entertainer Birmingham Bullring", LOCATIONS[0]), false);
});

test("curated official incoming evidence becomes branch-specific advisory Echo only for uniquely matched branches", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return LOCATIONS; },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };
  const result = await reconcileCuratedIncomingIntel({
    store,
    entries: [entry()],
    now: Date.parse("2026-08-26T16:00:00+01:00"),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.matchedBranches, 2);
  assert.equal(result.saved, 2);
  assert.equal(result.unmatchedTargets.length, 0);
  assert.deepEqual(new Set(saved.map((row) => row.locationId)), new Set(["loc-watford", "loc-basildon"]));
  for (const row of saved) {
    assert.equal(row.kind, "echo");
    assert.equal(row.retailerId, "entertainer-uk");
    assert.ok(row.locationId, "incoming retailer evidence must resolve to an exact canonical branch before this reconciler persists it");
    assert.equal(row.productIdentityId, null, "styles-vary incoming evidence must not guess a canonical product variant");
    assert.equal(row.evidence.advisory, true);
    assert.equal(row.evidence.scope, "exact_branch_advisory");
    assert.equal(row.evidence.sourceType, "official_retailer_page");
    assert.equal(row.evidence.availabilityVerified, false);
    assert.equal(row.evidence.expectedLabel, "Expected 28 August");
    assert.equal("stockStatus" in row.evidence, false);
  }
});

test("unmatched or ambiguous target branches fail closed instead of becoming chain-wide intelligence", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() {
      return [
        ...LOCATIONS,
        { id: "loc-watford-2", retailerId: "entertainer-uk", name: "The Entertainer", address: "Another Centre, Watford", postcode: "WD18 0AA" },
      ];
    },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };
  const result = await reconcileCuratedIncomingIntel({
    store,
    entries: [entry({ targetBranches: ["The Entertainer Watford", "The Entertainer Neverwhere"] })],
    now: Date.parse("2026-08-26T16:00:00+01:00"),
  });
  assert.equal(result.saved, 0);
  assert.equal(result.unmatchedTargets.length, 2);
  assert.deepEqual(new Set(result.unmatchedTargets.map((row) => row.reason)), new Set(["ambiguous_branch_match", "branch_not_found"]));
});

test("expired curated evidence is not persisted", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() { return LOCATIONS; },
    async upsertLocalStockObservations() { writes += 1; return { saved: 0 }; },
  };
  const result = await reconcileCuratedIncomingIntel({
    store,
    entries: [entry()],
    now: Date.parse("2026-08-30T12:00:00+01:00"),
  });
  assert.equal(result.activeEntries, 0);
  assert.equal(result.matchedBranches, 0);
  assert.equal(writes, 0);
});

test("production curated record is time-bounded official preparation evidence, never a stock claim", () => {
  const real = CURATED_INCOMING_INTEL[0];
  assert.equal(real.retailerId, "entertainer-uk");
  assert.equal(real.kind, "echo");
  assert.equal(real.rawProductTitle, "Pokémon TCG: Mega Forces Tin (Styles Vary)");
  assert.equal(real.expectedLabel, "Expected 28 August");
  assert.match(real.sourceUrl, /thetoyshop\.com\/pokemon-at-the-entertainer/);
  assert.ok(Date.parse(real.expiresAt) > Date.parse(real.expectedTo));
  assert.ok(real.targetBranches.length > 5);
});
