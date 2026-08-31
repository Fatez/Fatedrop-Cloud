import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets, listAlertFacetOptions } from "../src/core/alert-facets.mjs";

test("alert facets describe explicit language without treating it as verified market identity", () => {
  assert.deepEqual(
    deriveAlertFacets({ title: "Pokemon Abyss Eye Japanese Booster Box", retailerCountryCode: "GB" }),
    {
      version: 2,
      languageGroup: "japanese",
      languageCode: "ja",
      marketCode: null,
      marketGroup: "unknown",
      marketStatus: "unknown",
      languageLabel: "Japanese",
      setKey: "abyss-eye",
      setName: "Abyss Eye",
      confidence: { language: 1, market: 0, set: 1 },
      source: { language: "explicit_language", market: "unknown", set: "title_alias:abyss eye" },
    },
  );
  assert.equal(deriveAlertFacets({ title: "Pokemon 151 Korean Booster Box", retailerCountryCode: "GB" }).languageGroup, "korean");
  assert.equal(deriveAlertFacets({ title: "Terastal Grand Gathering Simplified Chinese Booster Box", retailerCountryCode: "GB" }).languageGroup, "simplified_chinese");
  assert.equal(deriveAlertFacets({ title: "Emerald Storm Traditional Chinese Taiwan Booster Box", retailerCountryCode: "GB" }).marketCode, null);
  assert.equal(deriveAlertFacets({ title: "Emerald Storm Traditional Chinese Booster Box", retailerCountryCode: "GB" }).languageGroup, "traditional_chinese");
  assert.equal(deriveAlertFacets({ title: "Pokemon Chinese Mystery Booster Box", retailerCountryCode: "GB" }).languageGroup, "unknown");
  assert.equal(deriveAlertFacets({ title: "Pokemon Booster Box [KR]", retailerCountryCode: "GB" }).languageGroup, "korean");
  assert.equal(deriveAlertFacets({ title: "Pokemon Booster Box [CN]", retailerCountryCode: "GB" }).languageGroup, "simplified_chinese");
  assert.equal(deriveAlertFacets({ title: "Pokemon Booster Box [CHS]", retailerCountryCode: "GB" }).languageGroup, "simplified_chinese");
  assert.equal(deriveAlertFacets({ title: "Pokemon Booster Box [CHT]", retailerCountryCode: "GB" }).languageGroup, "traditional_chinese");
});

test("Obsidian Flames canonical set scope resolves English without manufacturing market or RRP authority", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon - Scarlet & Violet - Obsidian Flames - Booster Pack",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.languageCode, "en");
  assert.equal(facets.languageLabel, "English");
  assert.equal(facets.setKey, "obsidian-flames");
  assert.equal(facets.setName, "Obsidian Flames");
  assert.equal(facets.source.language, "canonical_set_scope:obsidian-flames");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketGroup, "unknown");
  assert.equal(facets.marketStatus, "unknown");
  assert.equal(Object.hasOwn(facets, "rrpPence"), false);
});

test("Destined Rivals canonical set scope resolves English without inheriting UK retailer market", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Destined Rivals Booster Bundle",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.languageCode, "en");
  assert.equal(facets.setKey, "destined-rivals");
  assert.equal(facets.source.language, "canonical_set_scope:destined-rivals");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("Pokemon 151 remains unknown without printing or explicit language evidence", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon 151 Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "pokemon-151");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.source.language, "unknown");
  assert.equal(facets.marketCode, null);
});

test("Gem 5 resolves Simplified Chinese from canonical set authority, not English-looking title text", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Gem 5 Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "gem-5");
  assert.equal(facets.languageGroup, "simplified_chinese");
  assert.equal(facets.languageCode, "zh-Hans");
  assert.equal(facets.languageLabel, "Simplified Chinese");
  assert.equal(facets.source.language, "canonical_set_scope:gem-5");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("UK retailer plus generic listing remains unknown", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
  assert.equal(facets.confidence.language, 0);
  assert.equal(facets.source.language, "unknown");
  assert.equal(facets.setKey, null);
});

test("explicit language conflicting with a language-exclusive canonical set is quarantined", () => {
  const facets = deriveAlertFacets({
    title: "Obsidian Flames Japanese Booster Pack",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "obsidian-flames");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.languageLabel, "Unknown language");
  assert.equal(facets.confidence.language, 1);
  assert.match(facets.source.language, /^language_conflict:/);
  assert.match(facets.source.language, /japanese:english:obsidian-flames$/);
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("previously persisted unknown version-2 facets are safely enriched from canonical set scope", () => {
  const oldUnknownEvidence = [{
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
    setKey: "obsidian-flames",
    setName: "Obsidian Flames",
    setConfidence: 1,
    setSource: "title_alias:obsidian flames",
  }];
  const facets = deriveAlertFacets({
    title: "Pokemon - Scarlet & Violet - Obsidian Flames - Booster Pack",
    retailerCountryCode: "GB",
    evidence: oldUnknownEvidence,
  });
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.languageCode, "en");
  assert.equal(facets.source.language, "canonical_set_scope:obsidian-flames");
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
});

test("persisted unknown facets can also gain a newly recognised set identity safely", () => {
  const oldUnknownEvidence = [{
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
  }];
  const facets = deriveAlertFacets({
    title: "Hidden Fates Booster Pack",
    retailerCountryCode: "GB",
    evidence: oldUnknownEvidence,
  });
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.setKey, "hidden-fates");
  assert.equal(facets.setName, "Hidden Fates");
  assert.equal(facets.source.language, "canonical_set_scope:hidden-fates");
  assert.equal(facets.marketCode, null);
});

test("persisted conflicting language evidence is quarantined instead of winning silently", () => {
  const facets = deriveAlertFacets({
    title: "Obsidian Flames Booster Pack",
    retailerCountryCode: "GB",
    evidence: [{
      kind: "alert_facets",
      version: 2,
      languageGroup: "japanese",
      languageCode: "ja",
      marketCode: null,
      marketGroup: "unknown",
      marketStatus: "unknown",
      languageConfidence: 1,
      languageSource: "operator_verified",
      marketConfidence: 0,
      marketSource: "unknown",
      setKey: "obsidian-flames",
      setName: "Obsidian Flames",
      setConfidence: 1,
      setSource: "title_alias:obsidian flames",
    }],
  });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.confidence.language, 1);
  assert.match(facets.source.language, /^language_conflict:persisted_operator_verified:japanese:english:obsidian-flames$/);
});

test("a generic persisted unknown remains unknown when no stronger canonical evidence appears", () => {
  const evidence = [{
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
  }];
  const facets = deriveAlertFacets({
    title: "Pokemon Booster Pack",
    retailerCountryCode: "GB",
    evidence,
  });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.setKey, null);
  assert.equal(facets.source.language, "unknown");
});

test("only a verified canonical market resolution emits a market facet", () => {
  const facets = deriveAlertFacets({
    title: "Pokemon Abyss Eye Booster Box",
    language: "en",
    marketResolution: { status: "verified", marketCode: "JP", confidence: 1, source: "authoritative_market_msrp" },
  });
  assert.equal(facets.languageGroup, "english");
  assert.equal(facets.marketCode, "JP");
  assert.equal(facets.marketGroup, "japanese");
  assert.equal(facets.marketStatus, "verified");
});

test("persisted known facets still win when they do not conflict with canonical set scope", () => {
  const facets = deriveAlertFacets({
    title: "Unmapped Collector Product",
    retailerCountryCode: "GB",
    evidence: [{
      kind: "alert_facets",
      version: 2,
      languageGroup: "other",
      languageCode: "fr",
      marketCode: null,
      marketGroup: "unknown",
      marketStatus: "unknown",
      languageConfidence: 1,
      languageSource: "operator_verified",
      marketConfidence: 0,
      marketSource: "unknown",
      setKey: null,
      setName: null,
      setConfidence: 0,
      setSource: "unknown",
    }],
  });
  assert.equal(facets.languageGroup, "other");
  assert.equal(facets.languageCode, "fr");
  assert.equal(facets.setKey, null);
  assert.equal(facets.source.language, "operator_verified");
});

test("BCP 47 Chinese language tags remain separated after normalization", () => {
  assert.equal(deriveAlertFacets({ title: "Booster Box", language: "zh-CN" }).languageGroup, "simplified_chinese");
  assert.equal(deriveAlertFacets({ title: "Booster Box", language: "zh-TW" }).languageGroup, "traditional_chinese");
  assert.equal(deriveAlertFacets({ title: "Booster Box", language: "zh-HK" }).languageGroup, "traditional_chinese");
});

test("facet option contract exposes stable language and set keys for Web and App", () => {
  const options = listAlertFacetOptions();
  assert.deepEqual(options.languages.map((item) => item.key), [
    "english",
    "japanese",
    "korean",
    "simplified_chinese",
    "traditional_chinese",
    "other",
    "unknown",
  ]);
  assert.deepEqual(options.markets.map((item) => item.key), [
    "english",
    "japanese",
    "korean",
    "simplified_chinese",
    "traditional_chinese",
    "other",
    "unknown",
  ]);
  const keys = new Set(options.sets.map((item) => item.key));
  for (const key of ["destined-rivals", "hidden-fates", "obsidian-flames", "pokemon-151", "abyss-eye", "inferno-x", "terastal-grand-gathering", "gem-5", "gem-6"]) {
    assert.equal(keys.has(key), true, key);
  }
});
