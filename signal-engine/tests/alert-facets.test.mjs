import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets, listAlertFacetOptions } from "../src/core/alert-facets.mjs";

test("alert facets describe explicit language without treating it as verified market identity", () => {
  const { canonicalIdentity, ...facets } = deriveAlertFacets({ title: "Pokemon Abyss Eye Japanese Booster Box", retailerCountryCode: "GB" });
  assert.deepEqual(
    facets,
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
  assert.equal(canonicalIdentity.kind, "expansion");
  assert.equal(canonicalIdentity.key, "abyss-eye");
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

test("Celebrations resolves as an exact multilingual expansion without guessing English", () => {
  const facets = deriveAlertFacets({
    title: "Pokémon Celebrations Elite Trainer Box (25th Anniversary)",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.setKey, "celebrations");
  assert.equal(facets.setName, "Celebrations");
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.canonicalIdentity.kind, "expansion");
  assert.equal(facets.canonicalIdentity.exactSet, true);
  assert.equal(facets.canonicalIdentity.languageScope, "multilingual");
  assert.equal(facets.marketCode, null);
});

test("Time Gazer S10D keeps explicit Korean and resolves the exact authority-backed expansion", () => {
  const facets = deriveAlertFacets({
    title: "Pokémon TCG Time Gazer S10D Korean Booster Box",
    retailerCountryCode: "GB",
  });
  assert.equal(facets.languageGroup, "korean");
  assert.equal(facets.languageCode, "ko");
  assert.equal(facets.setKey, "time-gazer");
  assert.equal(facets.setName, "Time Gazer");
  assert.equal(facets.source.set, "title_alias:time gazer s10d");
  assert.equal(facets.marketCode, null);
});

test("Mega Lucario ex League Battle Deck is a canonical deck and never an invented expansion", () => {
  const facets = deriveAlertFacets({ title: "Pokémon TCG: Mega Lucario ex League Battle Deck", retailerCountryCode: "GB" });
  assert.equal(facets.setKey, null);
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.canonicalIdentity.status, "resolved");
  assert.equal(facets.canonicalIdentity.kind, "battle_deck");
  assert.equal(facets.canonicalIdentity.key, "mega-lucario-ex-league-battle-deck");
});

test("First Partner Illustration Collection Series 2 is a special collection and inherits no nearby set", () => {
  const facets = deriveAlertFacets({ title: "Pokémon TCG: First Partner Illustration Collection - Series 2", retailerCountryCode: "GB" });
  assert.equal(facets.setKey, null);
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.canonicalIdentity.status, "resolved");
  assert.equal(facets.canonicalIdentity.kind, "special_collection");
  assert.equal(facets.canonicalIdentity.key, "first-partner-illustration-collection-series-2");
});

test("Pitch Black Build and Battle resolves through registered expansion authority without creating market truth", () => {
  const facets = deriveAlertFacets({ title: "Pokémon TCG: Pitch Black - Build & Battle Box", retailerCountryCode: "GB" });
  assert.equal(facets.setKey, "pitch-black");
  assert.equal(facets.setName, "Pitch Black");
  assert.equal(facets.canonicalIdentity.productFamily.kind, "build_and_battle");
  assert.equal(facets.source.set, "title_alias:pitch black");
  assert.equal(facets.marketCode, null);
  assert.equal(Object.hasOwn(facets, "rrpPence"), false);
});

test("Ascended Heroes resolves exactly and generic Mega Evolution remains only a broad series", () => {
  const exact = deriveAlertFacets({ title: "Pokémon TCG: Ascended Heroes - Mini Tin Case", retailerCountryCode: "GB" });
  assert.equal(exact.setKey, "ascended-heroes");
  assert.equal(exact.setName, "Ascended Heroes");
  assert.equal(exact.canonicalIdentity.seriesKey, "mega-evolution");
  assert.equal(exact.canonicalIdentity.productFamily.kind, "tin_case_assortment");

  const broad = deriveAlertFacets({ title: "Pokémon TCG: Mega Evolution Elite Trainer Box", retailerCountryCode: "GB" });
  assert.equal(broad.setKey, null);
  assert.equal(broad.languageGroup, "unknown");
  assert.equal(broad.canonicalIdentity.status, "broad_family_only");
  assert.equal(broad.canonicalIdentity.kind, "series");
});

test("legacy auto-derived Mega Evolution family may be corrected by a stronger exact identity", () => {
  const facets = deriveAlertFacets({
    title: "Pokémon TCG: Mega Evolution Ascended Heroes Elite Trainer Box",
    evidence: [{
      kind: "alert_facets",
      version: 2,
      languageGroup: "english",
      languageCode: "en",
      languageConfidence: 0.99,
      languageSource: "canonical_set_scope:mega-evolution",
      marketCode: null,
      marketStatus: "unknown",
      marketConfidence: 0,
      marketSource: "unknown",
      setKey: "mega-evolution",
      setName: "Mega Evolution",
      setConfidence: 1,
      setSource: "title_alias:mega evolution",
    }],
  });
  assert.equal(facets.setKey, "ascended-heroes");
  assert.equal(facets.setName, "Ascended Heroes");
  assert.equal(facets.canonicalIdentity.key, "ascended-heroes");
});

test("protected persisted exact identity conflicts are quarantined and never overwritten", () => {
  const facets = deriveAlertFacets({
    title: "Pokémon TCG: Ascended Heroes Elite Trainer Box",
    evidence: [{
      kind: "alert_facets",
      version: 2,
      languageGroup: "english",
      languageCode: "en",
      languageConfidence: 1,
      languageSource: "operator_verified",
      marketCode: null,
      marketStatus: "unknown",
      marketConfidence: 0,
      marketSource: "unknown",
      setKey: "pitch-black",
      setName: "Pitch Black",
      setConfidence: 1,
      setSource: "operator_verified",
    }],
  });

  assert.equal(facets.setKey, "pitch-black");
  assert.equal(facets.setName, "Pitch Black");
  assert.equal(facets.canonicalIdentity.status, "conflict");
  assert.match(facets.canonicalIdentity.source, /^canonical_identity_conflict:pitch-black:ascended-heroes$/);
  assert.equal(facets.marketCode, null);
});

test("unsupported near-match words do not manufacture the Pitch Black identity", () => {
  const facets = deriveAlertFacets({ title: "Pokémon TCG: Pitch Darkness Build & Battle Box", retailerCountryCode: "GB" });
  assert.equal(facets.setKey, null);
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.canonicalIdentity.status, "unresolved");
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
  for (const key of ["destined-rivals", "hidden-fates", "obsidian-flames", "pokemon-151", "celebrations", "time-gazer", "ascended-heroes", "pitch-black", "abyss-eye", "inferno-x", "terastal-grand-gathering", "gem-5", "gem-6"]) {
    assert.equal(keys.has(key), true, key);
  }
  assert.equal(keys.has("mega-evolution"), false, "a series must not appear as an exact set option");
  assert.equal(keys.has("mega-lucario-ex-league-battle-deck"), false, "a deck must not appear as a set option");
});
