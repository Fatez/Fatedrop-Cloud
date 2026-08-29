import assert from "node:assert/strict";
import test from "node:test";

import {
  CURATED_INCOMING_INTEL,
  expectedIntelClearAt,
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

test("Echo lifetime follows the expected physical-stock date and clears at the start of the following London day", () => {
  assert.equal(expectedIntelClearAt({
    expectedFrom: "2026-09-01T00:00:00+01:00",
    expectedTo: "2026-09-01T23:59:59+01:00",
    expiresAt: "2026-08-30T12:00:00+01:00",
  }), "2026-09-01T23:00:00.000Z");
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
  assert.equal(result.retailerChainRecords, 0);
  assert.equal(result.saved, 2);
  assert.equal(result.unmatchedTargets.length, 0);
  assert.deepEqual(new Set(saved.map((row) => row.locationId)), new Set(["loc-watford", "loc-basildon"]));
  for (const row of saved) {
    assert.equal(row.kind, "echo");
    assert.equal(row.retailerId, "entertainer-uk");
    assert.ok(row.locationId, "ordinary official-page intel still requires an exact branch before persistence");
    assert.equal(row.productIdentityId, null, "styles-vary incoming evidence must not guess a canonical product variant");
    assert.equal(row.evidence.advisory, true);
    assert.equal(row.evidence.scope, "exact_branch_advisory");
    assert.equal(row.evidence.evidenceLevel, "inventory_preparation");
    assert.equal(row.evidence.sourceType, "official_retailer_page");
    assert.equal(row.evidence.availabilityVerified, false);
    assert.equal(row.evidence.expectedLabel, "Expected 28 August");
    assert.equal(row.evidence.expiresAt, "2026-08-28T23:00:00.000Z");
    assert.equal("stockStatus" in row.evidence, false);
  }
});

test("weak or unresolved official-page targets fail closed instead of becoming chain-wide intelligence", async () => {
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
  assert.equal(result.retailerChainRecords, 0);
  assert.equal(result.unmatchedTargets.length, 2);
  assert.deepEqual(new Set(result.unmatchedTargets.map((row) => row.reason)), new Set(["ambiguous_branch_match", "branch_not_found"]));
});

test("strong retailer staff Echo persists as retailer-chain intelligence with zero resolved branches", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };
  const result = await reconcileCuratedIncomingIntel({
    store,
    entries: [entry({
      retailerId: "smyths-uk",
      sourceType: "retailer_staff_report",
      sourceId: "operator:smyths-manager:2026-08-29",
      targetBranches: [],
      rawProductTitle: "Pokémon TCG: Destined Rivals ETBs + Temporal Forces",
    })],
    now: Date.parse("2026-08-26T16:00:00+01:00"),
  });

  assert.equal(result.matchedBranches, 0);
  assert.equal(result.retailerChainRecords, 1);
  assert.equal(result.saved, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].retailerId, "smyths-uk");
  assert.equal(saved[0].locationId, null);
  assert.equal(saved[0].kind, "echo");
  assert.equal(saved[0].evidence.scope, "retailer_chain");
  assert.equal(saved[0].evidence.localIntel, true);
  assert.equal(saved[0].evidence.advisory, true);
  assert.equal(saved[0].evidence.availabilityVerified, false);
  assert.equal(saved[0].evidence.branchVerified, false);
});

test("future-dated Echo stays active even if an operator supplied an earlier expiry, then clears on the following day", async () => {
  const saved = [];
  const futureEntry = entry({
    retailerId: "smyths-uk",
    sourceType: "retailer_staff_report",
    sourceId: "operator:smyths-manager:2026-08-29",
    targetBranches: [],
    expectedFrom: "2026-09-01T00:00:00+01:00",
    expectedTo: "2026-09-01T23:59:59+01:00",
    expectedLabel: "Expected 1 September",
    expiresAt: "2026-08-30T12:00:00+01:00",
  });
  const store = {
    async listRetailerLocations() { return []; },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };

  const beforeClear = await reconcileCuratedIncomingIntel({
    store,
    entries: [futureEntry],
    now: Date.parse("2026-09-01T22:30:00+01:00"),
  });
  assert.equal(beforeClear.activeEntries, 1);
  assert.equal(beforeClear.saved, 1);
  assert.equal(saved[0].evidence.expiresAt, "2026-09-01T23:00:00.000Z");

  const afterClear = await reconcileCuratedIncomingIntel({
    store,
    entries: [futureEntry],
    now: Date.parse("2026-09-02T00:00:00+01:00"),
  });
  assert.equal(afterClear.activeEntries, 0);
});

test("strong chain Echo persists once at retailer level and only fans out to branches that actually resolve", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return [LOCATIONS[0]]; },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };
  const result = await reconcileCuratedIncomingIntel({
    store,
    entries: [entry({
      sourceType: "retailer_staff_report",
      sourceId: "staff:test",
      targetBranches: ["The Entertainer Watford", "The Entertainer Neverwhere"],
    })],
    now: Date.parse("2026-08-26T16:00:00+01:00"),
  });

  assert.equal(result.matchedBranches, 1);
  assert.equal(result.retailerChainRecords, 1);
  assert.equal(result.saved, 2);
  assert.equal(result.unmatchedTargets.length, 1);
  assert.equal(saved.filter((row) => row.locationId === null).length, 1);
  assert.equal(saved.filter((row) => row.locationId === "loc-watford").length, 1);
  assert.equal(saved.find((row) => row.locationId === null).evidence.scope, "retailer_chain");
  assert.equal(saved.find((row) => row.locationId === "loc-watford").evidence.scope, "exact_branch_advisory");
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
  assert.equal(result.retailerChainRecords, 0);
  assert.equal(writes, 0);
});

test("production curated record is time-bounded official preparation evidence, never a stock claim", () => {
  const real = CURATED_INCOMING_INTEL[0];
  assert.equal(real.retailerId, "entertainer-uk");
  assert.equal(real.kind, "echo");
  assert.equal(real.rawProductTitle, "Pokémon TCG: Mega Forces Tin (Styles Vary)");
  assert.equal(real.expectedLabel, "Expected 28 August");
  assert.match(real.sourceUrl, /thetoyshop\.com\/pokemon-at-the-entertainer/);
  assert.equal(expectedIntelClearAt(real), "2026-08-28T23:00:00.000Z");
  assert.ok(real.targetBranches.length > 5);
});
