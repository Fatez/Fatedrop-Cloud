import assert from "node:assert/strict";
import test from "node:test";

import { deriveAlertFacets, listAlertFacetOptions } from "../src/core/alert-facets.mjs";

test("alert facets describe language without treating it as verified market identity", () => {
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

test("unmarked UK catalogue products remain unknown rather than inheriting the retailer market", () => {
  const facets = deriveAlertFacets({ title: "Pokemon Destined Rivals Elite Trainer Box", retailerCountryCode: "GB" });
  assert.equal(facets.languageGroup, "unknown");
  assert.equal(facets.languageCode, null);
  assert.equal(facets.marketCode, null);
  assert.equal(facets.marketStatus, "unknown");
  assert.equal(facets.confidence.language, 0);
  assert.equal(facets.source.language, "unknown");
  assert.equal(facets.setKey, "destined-rivals");
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

test("persisted facets win and unknown set remains explicitly unknown", () => {
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
  for (const key of ["destined-rivals", "abyss-eye", "inferno-x", "terastal-grand-gathering", "gem-6"]) {
    assert.equal(keys.has(key), true, key);
  }
});
