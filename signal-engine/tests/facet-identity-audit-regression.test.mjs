import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets, listAlertFacetOptions } from "../src/core/alert-facets.mjs";
import { facetResolutionDiagnostics } from "../src/telemetry/facet-resolution-audit.mjs";

function persistedUnknown(overrides = {}) {
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
    observedAt: 100,
    ...overrides,
  }];
}

test("screenshot regressions resolve only from canonical evidence", () => {
  const celebrations = deriveAlertFacets({ title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)", retailerCountryCode: "GB" });
  assert.equal(celebrations.languageGroup, "unknown");
  assert.equal(celebrations.setKey, "celebrations");
  assert.equal(celebrations.marketCode, null);
  assert.equal(celebrations.marketStatus, "unknown");

  const ascendedHeroes = deriveAlertFacets({ title: "Pokemon TCG: Ascended Heroes - Mini Tin Case", retailerCountryCode: "GB" });
  assert.equal(ascendedHeroes.languageGroup, "english");
  assert.equal(ascendedHeroes.setKey, "ascended-heroes");
  assert.equal(ascendedHeroes.marketCode, null);

  const pitchBlack = deriveAlertFacets({ title: "Pokemon TCG: Pitch Black - Build & Battle Box", retailerCountryCode: "GB" });
  assert.equal(pitchBlack.languageGroup, "english");
  assert.equal(pitchBlack.setKey, "pitch-black");
  assert.equal(pitchBlack.marketCode, null);

  const timeGazer = deriveAlertFacets({ title: "Pokemon TCG Time Gazer S10D Korean Booster Box", retailerCountryCode: "GB" });
  assert.equal(timeGazer.languageGroup, "korean");
  assert.equal(timeGazer.source.language, "explicit_language");
  assert.equal(timeGazer.setKey, "time-gazer");
  assert.equal(timeGazer.marketCode, null);
});

test("language-exclusive standalone product identities enrich language without manufacturing a set or market", () => {
  const lucario = deriveAlertFacets({ title: "Pokemon TCG: Mega Lucario ex League Battle Deck", retailerCountryCode: "GB" });
  assert.equal(lucario.languageGroup, "english");
  assert.equal(lucario.source.language, "canonical_product_scope:mega-lucario-ex-league-battle-deck");
  assert.equal(lucario.setKey, null);
  assert.equal(lucario.marketCode, null);
  assert.equal(lucario.marketStatus, "unknown");

  const firstPartner = deriveAlertFacets({ title: "Pokemon TCG: First Partner Illustration Collection - Series 2", retailerCountryCode: "GB" });
  assert.equal(firstPartner.languageGroup, "english");
  assert.equal(firstPartner.source.language, "canonical_product_scope:first-partner-illustration-collection-series-2");
  assert.equal(firstPartner.setKey, null);
  assert.equal(firstPartner.marketCode, null);
  assert.equal(firstPartner.marketStatus, "unknown");
});

test("multilingual set identities never guess language", () => {
  for (const [title, setKey] of [
    ["Pokemon Celebrations Elite Trainer Box", "celebrations"],
    ["Pokemon Time Gazer Booster Box", "time-gazer"],
    ["Pokemon 151 Booster Bundle", "pokemon-151"],
    ["Pokemon Black Bolt Elite Trainer Box", "black-bolt"],
    ["Pokemon White Flare Elite Trainer Box", "white-flare"],
  ]) {
    const facets = deriveAlertFacets({ title, retailerCountryCode: "GB" });
    assert.equal(facets.setKey, setKey, title);
    assert.equal(facets.languageGroup, "unknown", title);
    assert.equal(facets.marketCode, null, title);
  }
});

test("specific aliases win over broader families using the alias that actually matched", () => {
  const ascendedHeroes = deriveAlertFacets({
    title: "Pokemon TCG Mega Evolution Ascended Heroes Elite Trainer Box",
    retailerCountryCode: "GB",
  });
  assert.equal(ascendedHeroes.setKey, "ascended-heroes");
  assert.equal(ascendedHeroes.setName, "Ascended Heroes");
  assert.equal(ascendedHeroes.source.set, "title_alias:mega evolution ascended heroes");
  assert.notEqual(ascendedHeroes.setKey, "mega-evolution");

  const pitchBlack = deriveAlertFacets({
    title: "Pokemon TCG Mega Evolution Pitch Black Booster Bundle",
    retailerCountryCode: "GB",
  });
  assert.equal(pitchBlack.setKey, "pitch-black");
  assert.equal(pitchBlack.source.set, "title_alias:mega evolution pitch black");
});

test("known working examples remain intact", () => {
  const expected = [
    ["Pokemon Phantasmal Flames Booster Pack", "phantasmal-flames", "english"],
    ["Pokemon Prismatic Evolutions Elite Trainer Box", "prismatic-evolutions", "english"],
    ["Pokemon Mega Dream Japanese Booster Pack", "mega-dream-ex", "japanese"],
  ];
  for (const [title, setKey, languageGroup] of expected) {
    const facets = deriveAlertFacets({ title, retailerCountryCode: "GB" });
    assert.equal(facets.setKey, setKey, title);
    assert.equal(facets.languageGroup, languageGroup, title);
    assert.equal(facets.marketCode, null, title);
  }
});

test("UK retailer and English-looking generic titles still cannot create language, market or RRP authority", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Premium Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.setKey, null);
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
  assert.equal(Object.hasOwn(facets, "rrpPence"), false);
});

test("canonical product and set language conflicts fail closed", () => {
  const productConflict = deriveAlertFacets({ title: "Mega Lucario ex League Battle Deck Japanese", retailerCountryCode: "GB" });
  assert.equal(productConflict.languageGroup, "unknown");
  assert.equal(productConflict.languageCode, null);
  assert.match(productConflict.source.language, /^language_conflict:/);
  assert.equal(productConflict.marketCode, null);

  const setConflict = deriveAlertFacets({ title: "Pokemon Pitch Black Japanese Build & Battle Box", retailerCountryCode: "GB" });
  assert.equal(setConflict.setKey, "pitch-black");
  assert.equal(setConflict.languageGroup, "unknown");
  assert.match(setConflict.source.language, /japanese:english:pitch-black$/);
  assert.equal(setConflict.marketCode, null);
});

test("persisted zero-confidence Unknown facets safely enrich without creating market authority", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Mega Evolution Ascended Heroes Elite Trainer Box",
    retailerCountryCode: "GB",
    evidence: persistedUnknown(),
  });
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.setKey, "ascended-heroes");
  assert.equal(facets.source.language, "canonical_set_scope:ascended-heroes");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("persisted real conflicts remain quarantined instead of self-healing", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Ascended Heroes Elite Trainer Box",
    retailerCountryCode: "GB",
    evidence: persistedUnknown({
      languageGroup: "japanese",
      languageCode: "ja",
      languageConfidence: 1,
      languageSource: "operator_verified",
      setKey: "ascended-heroes",
      setName: "Ascended Heroes",
      setConfidence: 1,
      setSource: "operator_verified",
    }),
  });
  assert.equal(facets.setKey, "ascended-heroes");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.confidence.language, 1);
  assert.match(facets.source.language, /^language_conflict:persisted_operator_verified:japanese:english:ascended-heroes$/);
  assert.equal(facets.marketCode, null);
});

test("facet audit groups recurring unresolved identities and separates resolution classes", () => {
  const rows = [
    {
      id: "signal-1",
      state: "manifested",
      retailer_id: "retailer-a",
      retailer_name: "Retailer A",
      title: "Pokemon Mystery Premium Box",
      detected_at: 100,
      evidence: persistedUnknown(),
    },
    {
      id: "signal-2",
      state: "echo",
      retailer_id: "retailer-b",
      retailer_name: "Retailer B",
      title: "Pokemon TCG: Mystery Premium Box",
      detected_at: 200,
      evidence: persistedUnknown(),
    },
    {
      id: "signal-3",
      state: "manifested",
      retailer_id: "retailer-a",
      retailer_name: "Retailer A",
      title: "Pokemon TCG: Mega Lucario ex League Battle Deck",
      detected_at: 300,
      evidence: persistedUnknown(),
    },
    {
      id: "signal-4",
      state: "manifested",
      retailer_id: "retailer-c",
      retailer_name: "Retailer C",
      title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)",
      detected_at: 400,
      evidence: persistedUnknown(),
    },
    {
      id: "signal-5",
      state: "manifested",
      retailer_id: "retailer-c",
      retailer_name: "Retailer C",
      title: "Pokemon TCG Time Gazer S10D Korean Booster Box",
      detected_at: 500,
      evidence: [],
    },
    {
      id: "signal-6",
      state: "echo",
      retailer_id: "retailer-d",
      retailer_name: "Retailer D",
      title: "Pokemon Pitch Black Japanese Build & Battle Box",
      detected_at: 600,
      evidence: persistedUnknown(),
    },
    {
      id: "signal-7",
      state: "manifested",
      retailer_id: "retailer-b",
      retailer_name: "Retailer B",
      title: "Pokemon TCG: First Partner Illustration Collection - Series 2",
      detected_at: 700,
      evidence: persistedUnknown(),
    },
  ];

  const diagnostics = facetResolutionDiagnostics(rows);
  assert.equal(diagnostics.assessedSignals, 7);
  assert.equal(diagnostics.missingFacetEvidence, 1);
  assert.equal(diagnostics.unknownLanguage, 4);
  assert.equal(diagnostics.unknownSet, 4);
  assert.equal(diagnostics.languageConflicts, 1);
  assert.equal(diagnostics.bothUnresolved, 2);
  assert.equal(diagnostics.languageKnownSetUnknown, 2);
  assert.equal(diagnostics.setKnownLanguageUnknown, 1);
  assert.equal(diagnostics.conflictsQuarantined, 1);
  assert.equal(diagnostics.fullyResolved, 1);

  const mystery = diagnostics.topUnresolved.find((entry) => entry.title?.includes("Mystery Premium Box"));
  assert.ok(mystery);
  assert.equal(mystery.resolution, "both_unresolved");
  assert.equal(mystery.count, 2);
  assert.equal(mystery.firstSeenAt, 100);
  assert.equal(mystery.lastSeenAt, 200);
  assert.equal(mystery.retailers.length, 2);
  assert.deepEqual(mystery.needsReview, ["language", "set"]);

  const celebrations = diagnostics.topUnresolved.find((entry) => entry.setKey === "celebrations");
  assert.ok(celebrations);
  assert.equal(celebrations.resolution, "set_known_language_unknown");
  assert.equal(celebrations.languageGroup, "unknown");

  const conflict = diagnostics.topUnresolved.find((entry) => entry.resolution === "conflict_quarantined");
  assert.ok(conflict);
  assert.equal(conflict.setKey, "pitch-black");
  assert.match(conflict.languageSource, /^language_conflict:/);

  assert.equal(diagnostics.topUnresolved.some((entry) => entry.title?.includes("Time Gazer")), false);

  const retailerA = diagnostics.retailerDistribution.find((entry) => entry.retailerId === "retailer-a");
  assert.deepEqual(retailerA, {
    retailerId: "retailer-a",
    retailerName: "Retailer A",
    unresolvedSignals: 2,
    unresolvedLanguage: 1,
    unresolvedSet: 2,
    bothUnresolved: 1,
    conflictsQuarantined: 0,
  });
});

test("new canonical identities remain in facet options without a contract version bump", () => {
  const options = listAlertFacetOptions();
  assert.equal(options.version, 2);
  const keys = new Set(options.sets.map((set) => set.key));
  for (const key of ["ascended-heroes", "pitch-black", "celebrations", "time-gazer"]) {
    assert.equal(keys.has(key), true, key);
  }
});
