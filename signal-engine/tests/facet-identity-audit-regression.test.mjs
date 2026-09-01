import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets } from "../src/core/alert-facets.mjs";
import { facetResolutionDiagnostics } from "../src/telemetry/facet-resolution-audit.mjs";

test("screenshot regressions resolve only from canonical evidence", () => {
  const celebrations = deriveAlertFacets({ title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)", retailerCountryCode: "GB" });
  assert.equal(celebrations.languageGroup, "english");
  assert.equal(celebrations.setKey, "celebrations");
  assert.equal(celebrations.marketCode, null);

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
  assert.equal(timeGazer.setKey, "time-gazer");
  assert.equal(timeGazer.marketCode, null);
});

test("language-exclusive standalone product identities can enrich language without manufacturing a set or market", () => {
  const lucario = deriveAlertFacets({ title: "Pokemon TCG: Mega Lucario ex League Battle Deck", retailerCountryCode: "GB" });
  assert.equal(lucario.languageGroup, "english");
  assert.equal(lucario.source.language, "canonical_product_scope:mega-lucario-ex-league-battle-deck");
  assert.equal(lucario.setKey, null);
  assert.equal(lucario.marketCode, null);

  const firstPartner = deriveAlertFacets({ title: "Pokemon TCG: First Partner Illustration Collection - Series 2", retailerCountryCode: "GB" });
  assert.equal(firstPartner.languageGroup, "english");
  assert.equal(firstPartner.source.language, "canonical_product_scope:first-partner-illustration-collection-series-2");
  assert.equal(firstPartner.setKey, null);
  assert.equal(firstPartner.marketCode, null);
});

test("multilingual set identity never guesses language", () => {
  const facets = deriveAlertFacets({ title: "Pokemon Time Gazer Booster Box", retailerCountryCode: "GB" });
  assert.equal(facets.setKey, "time-gazer");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.marketCode, null);
});

test("canonical product language conflicts fail closed", () => {
  const facets = deriveAlertFacets({ title: "Mega Lucario ex League Battle Deck Japanese", retailerCountryCode: "GB" });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.match(facets.source.language, /^language_conflict:/);
  assert.equal(facets.marketCode, null);
});

test("facet audit automatically queues unresolved and conflicting signals", () => {
  const rows = [
    {
      id: "signal-1",
      state: "manifested",
      retailer_id: "retailer-a",
      retailer_name: "Retailer A",
      title: "Unmapped Product",
      detected_at: 100,
      evidence: [{ kind: "alert_facets", version: 2, languageGroup: "unknown", languageSource: "unknown", setKey: null, setName: null, setSource: "unknown", observedAt: 100 }],
    },
    {
      id: "signal-2",
      state: "manifested",
      retailer_id: "retailer-b",
      retailer_name: "Retailer B",
      title: "Known Product",
      detected_at: 101,
      evidence: [{ kind: "alert_facets", version: 2, languageGroup: "english", languageSource: "canonical_set_scope:pitch-black", setKey: "pitch-black", setName: "Pitch Black", setSource: "title_alias:pitch black", observedAt: 101 }],
    },
    {
      id: "signal-3",
      state: "echo",
      retailer_id: "retailer-c",
      retailer_name: "Retailer C",
      title: "Conflicted Product",
      detected_at: 102,
      evidence: [{ kind: "alert_facets", version: 2, languageGroup: "unknown", languageSource: "language_conflict:explicit_language:japanese:english:pitch-black", setKey: "pitch-black", setName: "Pitch Black", setSource: "title_alias:pitch black", observedAt: 102 }],
    },
  ];

  const diagnostics = facetResolutionDiagnostics(rows);
  assert.equal(diagnostics.assessedSignals, 3);
  assert.equal(diagnostics.unknownLanguage, 2);
  assert.equal(diagnostics.unknownSet, 1);
  assert.equal(diagnostics.languageConflicts, 1);
  assert.equal(diagnostics.reviewQueueSize, 2);
  assert.deepEqual(diagnostics.reviewQueue[0].needsReview, ["language", "set"]);
  assert.deepEqual(diagnostics.reviewQueue[1].needsReview, ["language", "language_conflict"]);
});
