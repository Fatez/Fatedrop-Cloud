import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets, listAlertFacetOptions } from "../src/core/alert-facets.mjs";
import { buildAlertFacetCoverage, loadAlertFacetCoverage } from "../src/telemetry/alert-facet-coverage.mjs";

function persistedUnknown() {
  return [{
    kind: "alert_facets",
    version: 2,
    languageGroup: "unknown",
    languageCode: null,
    marketCode: null,
    marketGroup: "unknown",
    marketStatus: "unknown",
    languageConfidence: 0,
    languageSource: "unknown",
    marketConfidence: 0,
    marketSource: "unknown",
    setKey: null,
    setName: null,
    setConfidence: 0,
    setSource: "unknown",
    observedAt: 1_800_000_000,
  }];
}

test("screenshot set identities enrich without weakening unknown-language semantics", () => {
  const celebrations = deriveAlertFacets({ title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)" });
  assert.equal(celebrations.languageGroup, "english");
  assert.equal(celebrations.setKey, "celebrations");
  assert.equal(celebrations.setName, "Celebrations");
  assert.deepEqual(celebrations.resolution, { language: "resolved", set: "resolved" });

  const ascendedHeroes = deriveAlertFacets({ title: "Pokemon TCG Mega Evolution Ascended Heroes Elite Trainer Box" });
  assert.equal(ascendedHeroes.languageGroup, "english");
  assert.equal(ascendedHeroes.setKey, "ascended-heroes");
  assert.equal(ascendedHeroes.setName, "Ascended Heroes");

  const pitchBlack = deriveAlertFacets({ title: "Pokemon TCG: Pitch Black - Build & Battle Box" });
  assert.equal(pitchBlack.languageGroup, "english");
  assert.equal(pitchBlack.setKey, "pitch-black");
  assert.equal(pitchBlack.setName, "Pitch Black");

  const koreanTimeGazer = deriveAlertFacets({ title: "Pokemon TCG Time Gazer S10D Korean Booster Box" });
  assert.equal(koreanTimeGazer.languageGroup, "korean");
  assert.equal(koreanTimeGazer.setKey, "time-gazer");
  assert.equal(koreanTimeGazer.setName, "Time Gazer");
  assert.deepEqual(koreanTimeGazer.resolution, { language: "resolved", set: "resolved" });

  const ambiguousTimeGazer = deriveAlertFacets({ title: "Pokemon TCG Time Gazer Booster Box" });
  assert.equal(ambiguousTimeGazer.languageGroup, "unknown");
  assert.equal(ambiguousTimeGazer.setKey, "time-gazer");
  assert.deepEqual(ambiguousTimeGazer.resolution, { language: "ambiguous_multilingual", set: "resolved" });
});

test("exact standalone product identities are not falsely presented as expansion sets", () => {
  const lucario = deriveAlertFacets({ title: "Pokemon TCG: Mega Lucario ex League Battle Deck" });
  assert.equal(lucario.languageGroup, "english");
  assert.equal(lucario.source.language, "canonical_product_scope:mega-lucario-ex-league-battle-deck");
  assert.equal(lucario.setKey, "not-set-specific");
  assert.equal(lucario.setName, "Not set-specific");
  assert.deepEqual(lucario.resolution, { language: "resolved", set: "not_applicable" });

  const firstPartner = deriveAlertFacets({ title: "Pokemon TCG: First Partner Illustration Collection - Series 2" });
  assert.equal(firstPartner.languageGroup, "english");
  assert.equal(firstPartner.setKey, "not-set-specific");
  assert.equal(firstPartner.setName, "Not set-specific");
  assert.equal(firstPartner.resolution.set, "not_applicable");

  const genericLeagueDeck = deriveAlertFacets({ title: "Pokemon TCG League Battle Deck" });
  assert.equal(genericLeagueDeck.languageGroup, "unknown");
  assert.equal(genericLeagueDeck.setKey, "not-set-specific");
  assert.equal(genericLeagueDeck.setName, "Not set-specific");
  assert.deepEqual(genericLeagueDeck.resolution, { language: "unresolved", set: "not_applicable" });

  const options = listAlertFacetOptions();
  assert.equal(options.sets.some((set) => set.key === "not-set-specific"), false);
});

test("UK geography and English-looking words still cannot manufacture language or set truth", () => {
  const generic = deriveAlertFacets({
    title: "Pokemon TCG Premium Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(generic.languageGroup, "unknown");
  assert.equal(generic.setKey, null);
  assert.deepEqual(generic.resolution, { language: "unresolved", set: "unresolved" });

  const conflict = deriveAlertFacets({ title: "Japanese Pokemon Celebrations Elite Trainer Box" });
  assert.equal(conflict.languageGroup, "unknown");
  assert.equal(conflict.setKey, "celebrations");
  assert.equal(conflict.resolution.language, "conflict");
  assert.match(conflict.source.language, /^language_conflict:/);
});

test("persisted v2 unknown facets safely enrich from stronger canonical evidence", () => {
  const celebrations = deriveAlertFacets({
    title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)",
    evidence: persistedUnknown(),
  });
  assert.equal(celebrations.languageGroup, "english");
  assert.equal(celebrations.setKey, "celebrations");

  const lucario = deriveAlertFacets({
    title: "Pokemon TCG: Mega Lucario ex League Battle Deck",
    evidence: persistedUnknown(),
  });
  assert.equal(lucario.languageGroup, "english");
  assert.equal(lucario.setKey, "not-set-specific");
  assert.equal(lucario.setName, "Not set-specific");
});

test("facet coverage separates actionable gaps from intentional multilingual ambiguity", () => {
  const now = 1_800_000_000;
  const coverage = buildAlertFacetCoverage([
    { title: "Pokemon Celebrations Elite Trainer Box", retailer_id: "a", retailer_name: "A", state: "manifested", detected_at: now },
    { title: "Pokemon TCG Time Gazer Booster Box", retailer_id: "b", retailer_name: "B", state: "manifested", detected_at: now - 1 },
    { title: "Pokemon TCG Premium Booster Box", retailer_id: "c", retailer_name: "C", state: "manifested", detected_at: now - 2 },
    { title: "Pokemon TCG League Battle Deck", retailer_id: "d", retailer_name: "D", state: "manifested", detected_at: now - 3 },
    { title: "Japanese Pokemon Celebrations Elite Trainer Box", retailer_id: "e", retailer_name: "E", state: "manifested", detected_at: now - 4 },
  ]);

  assert.equal(coverage.available, true);
  assert.equal(coverage.sampleSize, 5);
  assert.equal(coverage.unresolvedLanguage, 2);
  assert.equal(coverage.ambiguousLanguage, 1);
  assert.equal(coverage.unresolvedSet, 1);
  assert.equal(coverage.languageConflicts, 1);
  assert.equal(coverage.actionableRows, 3);
  assert.equal(coverage.uniqueActionableTitles, 3);
  assert.equal(coverage.samples.some((sample) => sample.title.includes("Time Gazer")), false);
});

test("facet coverage loader is bounded and fails closed if its query is unavailable", async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ title: "Pokemon TCG Premium Booster Box", retailer_id: "a", retailer_name: "A", state: "manifested", detected_at: 1_800_000_000, evidence: [] }] };
    },
  };
  const coverage = await loadAlertFacetCoverage(pool, { now: 1_800_000_000, rowLimit: 250 });
  assert.equal(coverage.available, true);
  assert.equal(coverage.actionableRows, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[1], 250);
  assert.match(calls[0].sql, /LIMIT \$2/);

  const failed = await loadAlertFacetCoverage({ query: async () => { throw new Error("db down"); } });
  assert.equal(failed.available, false);
  assert.equal(failed.reason, "facet_coverage_query_failed");
});
