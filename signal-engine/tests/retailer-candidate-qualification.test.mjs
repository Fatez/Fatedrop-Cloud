import test from "node:test";
import assert from "node:assert/strict";
import {
  RETAILER_QUALIFICATION_MODE,
  candidateQualificationDecision,
  runCandidateQualificationCycle,
} from "../src/retailers/candidate-qualification.mjs";
import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";
import { retailerToAdapterConfig } from "../src/retailers/runtime.mjs";

function candidate(id, overrides = {}) {
  return normalizeRetailerCandidate({
    id,
    name: id,
    websiteUrl: `https://${id}.example`,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.CANDIDATE,
    catalogue: {
      feedUrl: `https://${id}.example/products.json?limit=250`,
      feedApproved: false,
      runtime: { maxPages: 20, delayMs: 1800, include: "pokemon", exclude: "single" },
    },
    ...overrides,
  });
}

test("candidate qualification decision is structured-only and respects cooldown", () => {
  const now = 2_000_000;
  assert.equal(candidateQualificationDecision(candidate("due"), null, { now }).eligible, true);
  assert.equal(candidateQualificationDecision(candidate("cool"), now - 60, { now }).reason, "cooldown");
  assert.equal(candidateQualificationDecision(candidate("generic", { adapterType: ADAPTER_TYPES.GENERIC_HTML }), null, { now }).reason, "adapter-not-structured");
  assert.equal(candidateQualificationDecision(candidate("ready", { state: RETAILER_STATES.READY }), null, { now }).reason, "lifecycle-state");
});

test("structured runtime preserves registry include/exclude filters", () => {
  const config = retailerToAdapterConfig(candidate("filtered"), { requireMonitored: false, allowUnapprovedFeed: true });
  assert.ok(config.include instanceof RegExp);
  assert.ok(config.exclude instanceof RegExp);
  assert.equal(config.include.test("Pokemon booster box"), true);
  assert.equal(config.exclude.test("Pokemon single card"), true);
});

test("qualification cycle dry-runs due candidates, records diagnostics and never publishes", async () => {
  const now = 2_000_000;
  const rows = [candidate("alpha"), candidate("beta")];
  const recorded = [];
  const registry = {
    async list() { return rows; },
    async latestMonitorRunTimes({ mode }) {
      assert.equal(mode, RETAILER_QUALIFICATION_MODE);
      return new Map([["beta", now - 60]]);
    },
    async recordMonitorRun(run) { recorded.push(run); },
  };

  const outcome = await runCandidateQualificationCycle({
    registry,
    now,
    cooldownSeconds: 3600,
    maxPages: 4,
    deadlineMs: 2000,
    dryRunFn: async (retailer) => {
      assert.equal(retailer.id, "alpha");
      assert.equal(retailer.catalogue.runtime.maxPages, 4, "qualification must bound catalogue depth");
      assert.equal(retailer.catalogue.feedApproved, false, "qualification must not approve the feed");
      return {
        diagnostics: {
          retailerId: retailer.id,
          productsObserved: 123,
          pagesScanned: 2,
          priceCoverage: 1,
          stockCoverage: 0.98,
          catalogueComplete: true,
          adapterQualified: true,
          relevance: { likelyPokemonSealed: 87 },
        },
      };
    },
  });

  assert.equal(outcome.candidates, 2);
  assert.equal(outcome.attempted, 1);
  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].retailerId, "alpha");
  assert.equal(recorded[0].published, false);
  assert.equal(recorded[0].diagnostics.mode, RETAILER_QUALIFICATION_MODE);
  assert.equal(recorded[0].diagnostics.productionWrites, false);
  assert.equal(recorded[0].diagnostics.productsObserved, 123);
});

test("qualification failure is isolated and recorded without turning into production health", async () => {
  const recorded = [];
  const registry = {
    async list() { return [candidate("broken")]; },
    async latestMonitorRunTimes() { return new Map(); },
    async recordMonitorRun(run) { recorded.push(run); },
  };
  const outcome = await runCandidateQualificationCycle({
    registry,
    now: 2_000_000,
    deadlineMs: 2000,
    dryRunFn: async () => { throw new Error("feed unavailable"); },
  });
  assert.equal(outcome.failed, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "failed");
  assert.equal(recorded[0].published, false);
  assert.equal(recorded[0].diagnostics.productionWrites, false);
  assert.match(recorded[0].failureDetail, /feed unavailable/);
});
