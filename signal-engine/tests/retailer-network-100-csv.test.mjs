import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateRetailerCandidates } from "../src/retailers/discovery.mjs";
import {
  ukIndependentTcgCsvLeads20260901,
  recoveredRetailerWorkforceLeads20260821,
  currentWebEvidenceRetailerLeads20260901,
  ukRetailerNetwork100Seeds20260901,
} from "../src/retailers/uk-retailer-network-100-2026-09-01.mjs";
import { ukRetailerDiscoverySeeds } from "../src/retailers/uk-discovery-seeds.mjs";
import { RETAILER_STATES, RRP_AUTHORITY, VERIFICATION_STATES } from "../src/retailers/registry.mjs";

test("CSV retailer intake preserves all 81 unique candidate domains fail-closed", () => {
  assert.equal(ukIndependentTcgCsvLeads20260901.length, 81);
  const hostnames = new Set(ukIndependentTcgCsvLeads20260901.map((candidate) => new URL(candidate.websiteUrl).hostname.replace(/^www\\./, "")));
  assert.equal(hostnames.size, 81);

  for (const candidate of ukIndependentTcgCsvLeads20260901) {
    assert.equal(candidate.state, RETAILER_STATES.CANDIDATE);
    assert.equal(candidate.verification, VERIFICATION_STATES.UNVERIFIED);
    assert.equal(candidate.rrpAuthority, RRP_AUTHORITY.NONE);
    assert.equal(candidate.catalogue.feedApproved, false);
    assert.deepEqual(candidate.tcgs, []);
  }
});

test("recovered workforce evidence and current web research stay candidate-only", () => {
  assert.equal(recoveredRetailerWorkforceLeads20260821.length, 18);
  assert.ok(currentWebEvidenceRetailerLeads20260901.some((candidate) => candidate.id === "tritex-games"));
  assert.ok(currentWebEvidenceRetailerLeads20260901.some((candidate) => candidate.id === "cob-and-pip"));

  for (const candidate of [...recoveredRetailerWorkforceLeads20260821, ...currentWebEvidenceRetailerLeads20260901]) {
    assert.equal(candidate.state, RETAILER_STATES.CANDIDATE);
    assert.equal(candidate.verification, VERIFICATION_STATES.UNVERIFIED);
    assert.equal(candidate.rrpAuthority, RRP_AUTHORITY.NONE);
    assert.equal(candidate.catalogue.feedApproved, false);
  }
});

test("combined UK discovery pool exceeds 100 unique retailers without granting monitoring authority", () => {
  assert.equal(ukRetailerNetwork100Seeds20260901.length, 101);

  const combined = deduplicateRetailerCandidates([
    ...ukRetailerDiscoverySeeds,
    ...ukRetailerNetwork100Seeds20260901,
  ]);

  assert.equal(combined.length, 109);
  assert.ok(combined.length >= 100);
  assert.equal(combined.filter((candidate) => candidate.state === RETAILER_STATES.MONITORED).length, 0);
  assert.equal(combined.filter((candidate) => candidate.verification === VERIFICATION_STATES.VERIFIED).length, 0);

  const trainers = combined.find((candidate) => candidate.hostname === "trainershaven.co.uk");
  const pulse = combined.find((candidate) => candidate.hostname === "pulsecollective.co.uk");
  assert.ok(trainers);
  assert.ok(pulse);
  assert.ok(trainers.tcgs.includes("pokemon"));
  assert.ok(pulse.tcgs.includes("pokemon"));
});

test("fresh web evidence enriches selected retailers without turning evidence into stock truth", () => {
  const tritex = ukRetailerNetwork100Seeds20260901.find((candidate) => candidate.id === "tritex-games");
  const cobAndPip = ukRetailerNetwork100Seeds20260901.find((candidate) => candidate.id === "cob-and-pip");
  const tierZero = ukRetailerNetwork100Seeds20260901.find((candidate) => candidate.hostname === "tierzerogames.com");

  assert.ok(tritex?.tcgs.includes("pokemon"));
  assert.ok(tritex?.tcgs.includes("one-piece"));
  assert.ok(cobAndPip?.tcgs.includes("pokemon"));
  assert.ok(cobAndPip?.tcgs.includes("one-piece"));
  assert.ok(tierZero?.tcgs.includes("pokemon"));

  for (const candidate of [tritex, cobAndPip, tierZero]) {
    assert.equal(candidate.state, RETAILER_STATES.CANDIDATE);
    assert.equal(candidate.verification, VERIFICATION_STATES.UNVERIFIED);
    assert.equal(candidate.rrpAuthority, RRP_AUTHORITY.NONE);
  }
});
