import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets, listAlertFacetOptions } from "../src/core/alert-facets.mjs";

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
    ...overrides,
  }];
}

test("Celebrations resolves the canonical set while language remains unknown because the identity is multilingual", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "celebrations");
  assert.equal(facets.setName, "Celebrations");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.source.language, "unknown");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("Time Gazer keeps explicit Korean language evidence and gains only canonical set identity", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon TCG Time Gazer S10D Korean Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "korean");
  assert.equal(facets.languageCode, "ko");
  assert.equal(facets.source.language, "explicit_language");
  assert.equal(facets.setKey, "time-gazer");
  assert.equal(facets.setName, "Time Gazer");
  assert.equal(facets.marketCode, null);
});

test("non-set product families do not manufacture expansion identity or English language", () => {
  for (const title of [
    "Pokemon TCG: Mega Lucario ex League Battle Deck",
    "Pokemon TCG: First Partner Illustration Collection - Series 2",
  ]) {
    const facets = deriveAlertFacets({ title, retailerCountryCode: "GB" });
    assert.equal(facets.setKey, null, title);
    assert.equal(facets.setName, null, title);
    assert.equal(facets.languageGroup, "unknown", title);
    assert.equal(facets.marketCode, null, title);
  }
});

test("Pitch Black is an exact canonical expansion and safely supplies English set scope only", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon TCG: Pitch Black - Build & Battle Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "pitch-black");
  assert.equal(facets.setName, "Pitch Black");
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.source.language, "canonical_set_scope:pitch-black");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
  assert.equal(Object.hasOwn(facets, "rrpPence"), false);
});

test("Ascended Heroes exact identity wins over the broader Mega Evolution family", () => {
  const miniTin = deriveAlertFacets({
    title: "Pokemon TCG: Ascended Heroes - Mini Tin Case",
    retailerCountryCode: "GB",
  });
  assert.equal(miniTin.setKey, "ascended-heroes");
  assert.equal(miniTin.setName, "Ascended Heroes");
  assert.equal(miniTin.languageGroup, "english");
  assert.equal(miniTin.marketCode, null);

  const prefixed = deriveAlertFacets({
    title: "Pokemon TCG Mega Evolution Ascended Heroes Elite Trainer Box",
    retailerCountryCode: "GB",
  });
  assert.equal(prefixed.setKey, "ascended-heroes");
  assert.equal(prefixed.setName, "Ascended Heroes");
  assert.equal(prefixed.source.set, "title_alias:mega evolution ascended heroes");
  assert.notEqual(prefixed.setKey, "mega-evolution");
});

test("known working set identities remain intact", () => {
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

test("UK retailer and English-looking generic product text still cannot create English or market truth", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Premium Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.setKey, null);
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("multilingual Celebrations accepts explicit non-English evidence without canonical conflict", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Celebrations German Elite Trainer Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "celebrations");
  assert.equal(facets.languageGroup, "other");
  assert.equal(facets.languageCode, "german");
  assert.equal(facets.source.language, "explicit_language");
  assert.equal(facets.marketCode, null);
});

test("explicit language conflicting with new language-exclusive set scope still quarantines", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Pitch Black Japanese Build & Battle Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "pitch-black");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.confidence.language, 1);
  assert.match(facets.source.language, /^language_conflict:/);
  assert.match(facets.source.language, /japanese:english:pitch-black$/);
  assert.equal(facets.marketCode, null);
});

test("persisted zero-confidence Unknown facets enrich from newly recognised exact identity without creating market", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Mega Evolution Ascended Heroes Elite Trainer Box",
    retailerCountryCode: "GB",
    evidence: persistedUnknown(),
  });
  assert.equal(facets.setKey, "ascended-heroes");
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.source.language, "canonical_set_scope:ascended-heroes");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("persisted verified language conflicts remain quarantined instead of self-healing", () => {
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

test("new canonical identities are available to Cloud consumers without changing facet contract version", () => {
  const options = listAlertFacetOptions();
  assert.equal(options.version, 2);
  const keys = new Set(options.sets.map((set) => set.key));
  for (const key of ["ascended-heroes", "pitch-black", "celebrations", "time-gazer"]) {
    assert.equal(keys.has(key), true, key);
  }
});
