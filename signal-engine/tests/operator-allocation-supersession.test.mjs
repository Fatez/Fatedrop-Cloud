import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOperatorIssueSupersessionList,
  supersedeOperatorPhysicalEchoObservations,
} from "../src/encounters/operator-allocation-supersession.mjs";
import {
  parseOperatorIssue,
  processOperatorIssue,
} from "../src/encounters/operator-local-radar-intake.mjs";

const NOW = Date.parse("2026-09-02T08:00:00Z");

function physicalIssue({
  number = 500,
  supersedesOperatorIssues = [490, 491],
  targetBranches = ["The Entertainer York"],
  testOnly = false,
  availabilityScope = "physical_branch",
} = {}) {
  return {
    number,
    state: "open",
    title: testOnly ? "[FATEDROP LOCAL RADAR] TEST ONLY" : "[FATEDROP LOCAL RADAR] Entertainer replacement allocation",
    user: { login: "Fatez" },
    created_at: "2026-09-02T07:55:00Z",
    body: JSON.stringify({
      schemaVersion: 1,
      testOnly,
      tcgCode: "pokemon",
      availabilityScope,
      retailerId: "entertainer-uk",
      retailerName: "The Entertainer",
      rawProductTitle: "Pokémon TCG: 30th Celebration Elite Trainer Box",
      kind: "echo",
      sourceType: "official_retailer_page",
      sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
      sourceLabel: "The Entertainer official Pokémon page",
      explicitTcgRelevance: true,
      physicalEvidenceState: "expected",
      expectedLabel: "Expected 16 September",
      expiresAt: "2026-09-17T23:59:59Z",
      confidence: 0.68,
      targetBranches,
      supersedesOperatorIssues,
    }),
  };
}

function yorkLocation() {
  return {
    id: "loc_entertainer_york",
    retailerId: "entertainer-uk",
    provider: "entertainer_official_curated_seed",
    providerId: "https://www.thetoyshop.com/store/york",
    name: "The Entertainer York",
    address: "York city centre",
    postcode: "YO1 9WY",
    latitude: 53.9599,
    longitude: -1.0873,
    verification: "official_retailer_branch",
    retailerCategory: "toy_store",
    storeFormat: "toy_store",
    operationalStatus: "open",
    tcgSellerStatus: "likely",
    tcgSellerConfidence: 85,
    identityStatus: "canonical",
  };
}

test("supersession list accepts only unique earlier operator issues", () => {
  assert.deepEqual(normalizeOperatorIssueSupersessionList([490, 491, 490], 500), [490, 491]);
  assert.throws(() => normalizeOperatorIssueSupersessionList([500], 500), /earlier operator issues/);
  assert.throws(() => normalizeOperatorIssueSupersessionList([501], 500), /earlier operator issues/);
  assert.throws(() => normalizeOperatorIssueSupersessionList(["bad"], 500), /positive integer/);
});

test("operator parser limits supersession to production physical-branch allocations", () => {
  const parsed = parseOperatorIssue(physicalIssue(), NOW);
  assert.deepEqual(parsed.supersedesOperatorIssues, [490, 491]);

  assert.throws(
    () => parseOperatorIssue(physicalIssue({ testOnly: true }), NOW),
    /TEST ONLY operator issues cannot supersede/,
  );

  assert.throws(
    () => parseOperatorIssue(physicalIssue({ availabilityScope: "online_retailer_readiness" }), NOW),
    /Only physical-branch operator allocations may supersede/,
  );
});

test("supersession SQL expires only physical Echo signal events and never retailer locations", async () => {
  const calls = [];
  const store = {
    async pool() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          return { rowCount: 7 };
        },
      };
    },
  };

  const result = await supersedeOperatorPhysicalEchoObservations({
    store,
    retailerId: "entertainer-uk",
    operatorIssueNumbers: [490, 491],
    supersededByOperatorIssue: 500,
    now: NOW,
  });

  assert.equal(result.superseded, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE fatedrop_signal_events/);
  assert.doesNotMatch(calls[0].sql, /UPDATE fatedrop_retailer_locations/);
  assert.match(calls[0].sql, /kind = 'echo'/);
  assert.match(calls[0].sql, /availabilityScope/);
  assert.match(calls[0].sql, /physical_branch/);
  assert.match(calls[0].sql, /sourceId/);
  assert.match(calls[0].sql, /supersessionReason/);
  assert.deepEqual(calls[0].args.slice(1), [500, "entertainer-uk", [490, 491], "github:Fatez/Fatedrop-Cloud:issue:"]);
});

test("new matched allocation persists before older operator allocation evidence is superseded", async () => {
  const writes = [];
  const supersessions = [];
  const store = {
    async listRetailerLocations() {
      return [yorkLocation()];
    },
    async upsertLocalStockObservations(observations) {
      writes.push(...observations);
      return { saved: observations.length, duplicates: 0 };
    },
    async supersedeOperatorPhysicalEchoObservations(payload) {
      supersessions.push(payload);
      return { superseded: 2 };
    },
  };

  const result = await processOperatorIssue({ issue: physicalIssue(), store, now: NOW });

  assert.equal(result.status, "ingested");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "echo");
  assert.equal(writes[0].retailerId, "entertainer-uk");
  assert.equal(writes[0].locationId, "loc_entertainer_york");
  assert.equal(writes[0].evidence.physicalEvidenceState, "expected");
  assert.equal(writes[0].evidence.availabilityVerified, false);
  assert.equal(supersessions.length, 1);
  assert.deepEqual(supersessions[0].operatorIssueNumbers, [490, 491]);
  assert.equal(supersessions[0].supersededByOperatorIssue, 500);
  assert.equal(result.supersession.superseded, 2);
  assert.equal(result.push.reason, "radius_targeting_required");
});

test("older allocation evidence remains active when replacement branch evidence cannot be persisted", async () => {
  let supersessionCalls = 0;
  const store = {
    async listRetailerLocations() {
      return [];
    },
    async upsertLocalStockObservations() {
      throw new Error("should not be called without a matched branch");
    },
    async supersedeOperatorPhysicalEchoObservations() {
      supersessionCalls += 1;
      return { superseded: 1 };
    },
  };

  const result = await processOperatorIssue({ issue: physicalIssue(), store, now: NOW });

  assert.equal(result.status, "held");
  assert.equal(result.matchedBranches, 0);
  assert.equal(result.supersession.superseded, 0);
  assert.equal(result.supersession.reason, "replacement_evidence_not_persisted");
  assert.equal(supersessionCalls, 0);
});
