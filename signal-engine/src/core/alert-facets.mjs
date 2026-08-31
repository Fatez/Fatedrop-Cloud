import { describeProductIdentity } from "./product-identity.mjs";
import { internationalMsrpAuthorities } from "../rrp/international-msrp-authority.mjs";
import { MARKET_GROUPS, marketGroupForCode, normalizeMarketCode } from "./market-memory-policy.mjs";

export const ALERT_FACET_VERSION = 2;

export const ALERT_LANGUAGE_GROUPS = Object.freeze([
  { key: "english", label: "English" },
  { key: "japanese", label: "Japanese" },
  { key: "korean", label: "Korean" },
  { key: "simplified_chinese", label: "Simplified Chinese" },
  { key: "traditional_chinese", label: "Traditional Chinese" },
  { key: "other", label: "Other languages" },
  { key: "unknown", label: "Unknown language" },
]);
export const ALERT_MARKET_GROUPS = MARKET_GROUPS;

const LANGUAGE_GROUP_KEYS = new Set(ALERT_LANGUAGE_GROUPS.map((group) => group.key));
const SINGLE_LANGUAGE_SCOPES = new Set([
  "english",
  "japanese",
  "korean",
  "simplified_chinese",
  "traditional_chinese",
]);

function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value = "") {
  return fold(value).replace(/\s+/g, "-");
}

function titleCase(value = "") {
  return String(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const ENGLISH_SET_FAMILIES = [
  ["destined-rivals", "Destined Rivals", ["destined rivals"], "english"],
  ["journey-together", "Journey Together", ["journey together"], "english"],
  ["prismatic-evolutions", "Prismatic Evolutions", ["prismatic evolutions"], "english"],
  ["surging-sparks", "Surging Sparks", ["surging sparks"], "english"],
  ["stellar-crown", "Stellar Crown", ["stellar crown"], "english"],
  ["shrouded-fable", "Shrouded Fable", ["shrouded fable"], "english"],
  ["twilight-masquerade", "Twilight Masquerade", ["twilight masquerade"], "english"],
  ["temporal-forces", "Temporal Forces", ["temporal forces"], "english"],
  ["paldean-fates", "Paldean Fates", ["paldean fates"], "english"],
  ["hidden-fates", "Hidden Fates", ["hidden fates"], "english"],
  ["paradox-rift", "Paradox Rift", ["paradox rift"], "english"],
  ["obsidian-flames", "Obsidian Flames", ["obsidian flames"], "english"],
  ["paldea-evolved", "Paldea Evolved", ["paldea evolved"], "english"],
  ["pokemon-151", "Pokémon 151", ["pokemon 151", "scarlet and violet 151", "scarlet violet 151"], "multilingual"],
  ["black-bolt", "Black Bolt", ["black bolt"], "multilingual"],
  ["white-flare", "White Flare", ["white flare"], "multilingual"],
  ["mega-evolution", "Mega Evolution", ["mega evolution"], "english"],
  ["phantasmal-flames", "Phantasmal Flames", ["phantasmal flames"], "english"],
  ["perfect-order", "Perfect Order", ["perfect order"], "english"],
  ["chaos-rising", "Chaos Rising", ["chaos rising"], "english"],
  ["crown-zenith", "Crown Zenith", ["crown zenith"], "english"],
  ["silver-tempest", "Silver Tempest", ["silver tempest"], "english"],
  ["lost-origin", "Lost Origin", ["lost origin"], "english"],
  ["astral-radiance", "Astral Radiance", ["astral radiance"], "english"],
  ["brilliant-stars", "Brilliant Stars", ["brilliant stars"], "english"],
  ["fusion-strike", "Fusion Strike", ["fusion strike"], "english"],
  ["evolving-skies", "Evolving Skies", ["evolving skies"], "english"],
  ["chilling-reign", "Chilling Reign", ["chilling reign"], "english"],
];

const INTERNATIONAL_ALIAS_FAMILIES = [
  ["team-rocket-glory", "Team Rocket Glory", ["team rocket glory", "glory of team rocket"], "unknown"],
  ["emerald-storm", "Emerald Storm", ["emerald storm", "storm emerald"], "unknown"],
  ["mega-dream-ex", "Mega Dream ex", ["mega dream ex", "mega dream"], "unknown"],
  ["nihil-zero", "Nihil Zero", ["nihil zero", "nullifying zero"], "unknown"],
  ["pokemon-151", "Pokémon 151", ["pokemon card 151", "pokemon 151"], "multilingual"],
  ["terastal-festival-ex", "Terastal Festival ex", ["terastal festival ex", "terastal festival"], "unknown"],
  ["gem-1", "Gem Vol. 1", ["gem vol 1", "gem 1"], "unknown"],
  ["gem-2", "Gem Vol. 2", ["gem vol 2", "gem 2"], "unknown"],
  ["gem-3", "Gem Vol. 3", ["gem vol 3", "gem 3"], "unknown"],
  ["gem-4", "Gem Vol. 4", ["gem vol 4", "gem 4"], "unknown"],
  ["gem-5", "Gem Vol. 5", ["gem vol 5", "gem 5"], "unknown"],
  ["gem-6", "Gem Vol. 6", ["gem vol 6", "gem 6"], "unknown"],
];

function languageScopeForMarket(market) {
  if (market === "JP") return "japanese";
  if (market === "KR") return "korean";
  if (market === "CN") return "simplified_chinese";
  if (market === "TW" || market === "HK") return "traditional_chinese";
  return "unknown";
}

function authoritySetFamilies() {
  return internationalMsrpAuthorities.flatMap((authority) => {
    if (Number.isFinite(authority?.directMsrp)) return [];
    const aliases = [...new Set((authority?.aliases || []).map(fold).filter(Boolean))];
    if (!aliases.length) return [];
    const authorityKey = String(authority.id || "").replace(/^(?:jp|kr|cn|tw|hk)-/, "");
    return [[
      authorityKey || slug(aliases[0]),
      titleCase(aliases[0]),
      aliases,
      languageScopeForMarket(authority.market),
    ]];
  });
}

function mergeLanguageScopes(left = "unknown", right = "unknown") {
  if (left === right) return left;
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  if (left === "multilingual" || right === "multilingual") return "multilingual";
  return "multilingual";
}

const AUTHORITY_SET_FAMILIES = authoritySetFamilies();

function buildSetRegistry() {
  const byKey = new Map();
  for (const [key, name, aliases, languageScope = "unknown"] of [
    ...ENGLISH_SET_FAMILIES,
    ...INTERNATIONAL_ALIAS_FAMILIES,
    ...AUTHORITY_SET_FAMILIES,
  ]) {
    const safeKey = slug(key);
    if (!safeKey) continue;
    const existing = byKey.get(safeKey);
    byKey.set(safeKey, {
      key: safeKey,
      name: existing?.name || name,
      aliases: [...new Set([...(existing?.aliases || []), ...(aliases || []).map(fold)].filter(Boolean))],
      languageScope: mergeLanguageScopes(existing?.languageScope, languageScope),
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const longestLeft = Math.max(...left.aliases.map((alias) => alias.length));
    const longestRight = Math.max(...right.aliases.map((alias) => alias.length));
    return longestRight - longestLeft || left.name.localeCompare(right.name);
  });
}

const SET_REGISTRY = Object.freeze(buildSetRegistry());

function evidenceEntries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistedFacets(entries) {
  const entry = entries.find((candidate) => candidate?.kind === "alert_facets" && candidate?.version === ALERT_FACET_VERSION);
  if (!entry || !LANGUAGE_GROUP_KEYS.has(entry.languageGroup)) return null;
  return {
    version: ALERT_FACET_VERSION,
    languageGroup: entry.languageGroup,
    languageCode: typeof entry.languageCode === "string" && entry.languageCode ? entry.languageCode : null,
    marketCode: normalizeMarketCode(entry.marketCode),
    marketGroup: marketGroupForCode(entry.marketCode),
    marketStatus: typeof entry.marketStatus === "string" ? entry.marketStatus : "unknown",
    languageLabel: ALERT_LANGUAGE_GROUPS.find((group) => group.key === entry.languageGroup)?.label || "Unknown language",
    setKey: typeof entry.setKey === "string" && entry.setKey ? entry.setKey : null,
    setName: typeof entry.setName === "string" && entry.setName ? entry.setName : null,
    confidence: {
      language: Number.isFinite(Number(entry.languageConfidence)) ? Number(entry.languageConfidence) : 0,
      market: Number.isFinite(Number(entry.marketConfidence)) ? Number(entry.marketConfidence) : 0,
      set: Number.isFinite(Number(entry.setConfidence)) ? Number(entry.setConfidence) : 0,
    },
    source: {
      language: typeof entry.languageSource === "string" ? entry.languageSource : "persisted",
      market: typeof entry.marketSource === "string" ? entry.marketSource : "unknown",
      set: typeof entry.setSource === "string" ? entry.setSource : entry.setKey ? "persisted" : "unknown",
    },
  };
}

function languageFromDescriptor(language) {
  const normalizedLanguage = language == null ? "" : fold(language).replace(/\s+/g, "_");

  if (["japanese", "ja", "jp", "jpn"].includes(normalizedLanguage)) {
    return { languageGroup: "japanese", languageCode: "ja", confidence: 1, source: "explicit_language" };
  }
  if (["korean", "ko", "kr"].includes(normalizedLanguage)) {
    return { languageGroup: "korean", languageCode: "ko", confidence: 1, source: "explicit_language" };
  }
  if (["simplified_chinese", "zh_hans", "zh_cn", "zh-cn", "cn"].includes(normalizedLanguage)) {
    return { languageGroup: "simplified_chinese", languageCode: "zh-Hans", confidence: 1, source: "explicit_language" };
  }
  if (["traditional_chinese", "zh_hant", "zh_tw", "zh_hk", "zh-tw", "zh-hk", "tw", "hk"].includes(normalizedLanguage)) {
    return { languageGroup: "traditional_chinese", languageCode: "zh-Hant", confidence: 1, source: "explicit_language" };
  }
  if (["english", "en", "gb", "uk"].includes(normalizedLanguage)) {
    return { languageGroup: "english", languageCode: "en", confidence: 1, source: "explicit_language" };
  }
  if (normalizedLanguage === "chinese_unspecified" || normalizedLanguage === "chinese") {
    return { languageGroup: "unknown", languageCode: null, confidence: 0.4, source: "ambiguous_chinese_marker" };
  }
  if (normalizedLanguage) {
    return { languageGroup: "other", languageCode: normalizedLanguage.replaceAll("_", "-"), confidence: 0.95, source: "explicit_language" };
  }
  return { languageGroup: "unknown", languageCode: null, confidence: 0, source: "unknown" };
}

function explicitTitleLanguage(title) {
  const normalized = ` ${fold(title)} `;
  if (/\b(?:japanese|jpn|jp|japan)\b/.test(normalized)) return { language: "japanese", region: "JP" };
  if (/\b(?:korean|kr|korea)\b/.test(normalized)) return { language: "korean", region: "KR" };
  if (/\b(?:simplified chinese|chs|cn|mainland china)\b/.test(normalized)) return { language: "simplified_chinese", region: "CN" };
  if (/\b(?:traditional chinese|cht)\b/.test(normalized)) {
    if (/\b(?:taiwan|tw)\b/.test(normalized)) return { language: "traditional_chinese", region: "TW" };
    if (/\b(?:hong kong|hk)\b/.test(normalized)) return { language: "traditional_chinese", region: "HK" };
    return { language: "traditional_chinese", region: null };
  }
  if (/\b(?:taiwan|tw)\b/.test(normalized)) return { language: "traditional_chinese", region: "TW" };
  if (/\b(?:hong kong|hk)\b/.test(normalized)) return { language: "traditional_chinese", region: "HK" };
  return { language: null, region: null };
}

function setFromTitle(title) {
  const normalized = fold(title);
  if (!normalized) return { setKey: null, setName: null, confidence: 0, source: "unknown", languageScope: "unknown" };
  const padded = ` ${normalized} `;
  for (const family of SET_REGISTRY) {
    const matched = family.aliases.find((alias) => padded.includes(` ${alias} `));
    if (!matched) continue;
    return {
      setKey: family.key,
      setName: family.name,
      confidence: 1,
      source: `title_alias:${matched}`,
      languageScope: family.languageScope || "unknown",
    };
  }
  return { setKey: null, setName: null, confidence: 0, source: "unknown", languageScope: "unknown" };
}

function canonicalSetLanguage(setFacet) {
  if (!setFacet?.setKey || !SINGLE_LANGUAGE_SCOPES.has(setFacet.languageScope)) return null;
  const languageCode = setFacet.languageScope === "english" ? "en"
    : setFacet.languageScope === "japanese" ? "ja"
      : setFacet.languageScope === "korean" ? "ko"
        : setFacet.languageScope === "simplified_chinese" ? "zh-Hans"
          : "zh-Hant";
  return {
    languageGroup: setFacet.languageScope,
    languageCode,
    confidence: 0.99,
    source: `canonical_set_scope:${setFacet.setKey}`,
  };
}

function conflictLanguage(leftGroup, rightGroup, setKey, leftSource = "detected") {
  return {
    languageGroup: "unknown",
    languageCode: null,
    confidence: 1,
    source: `language_conflict:${leftSource}:${leftGroup}:${rightGroup}:${setKey}`,
  };
}

function resolveLanguageFacet(detectedLanguageFacet, setFacet) {
  const setLanguage = canonicalSetLanguage(setFacet);
  if (!setLanguage) return detectedLanguageFacet;

  if (detectedLanguageFacet.languageGroup !== "unknown") {
    if (detectedLanguageFacet.languageGroup !== setLanguage.languageGroup) {
      return conflictLanguage(
        detectedLanguageFacet.languageGroup,
        setLanguage.languageGroup,
        setFacet.setKey,
        detectedLanguageFacet.source,
      );
    }
    return detectedLanguageFacet;
  }

  if (detectedLanguageFacet.source === "unknown") return setLanguage;
  if (detectedLanguageFacet.source === "ambiguous_chinese_marker" && !setLanguage.languageGroup.includes("chinese")) {
    return conflictLanguage("chinese_unspecified", setLanguage.languageGroup, setFacet.setKey, detectedLanguageFacet.source);
  }
  return detectedLanguageFacet;
}

function persistedMarketResolution(entries) {
  const entry = entries.find((candidate) => candidate?.kind === "canonical_market_resolution" && candidate?.version === 1);
  if (!entry) return null;
  const status = String(entry.status || "unknown");
  return {
    status,
    marketCode: ["verified", "reused"].includes(status) ? normalizeMarketCode(entry.marketCode) : null,
    candidateMarketCode: normalizeMarketCode(entry.candidateMarketCode),
    confidence: Number(entry.confidence) || 0,
    source: entry.source || "persisted_market_resolution",
  };
}

export function deriveAlertFacets({ title = "", language = null, region = null, retailerCountryCode = null, evidence = [], marketResolution = null } = {}) {
  const entries = evidenceEntries(evidence);
  const persisted = persistedFacets(entries);
  const descriptor = describeProductIdentity({ title, language, region });
  const titleLanguage = explicitTitleLanguage(title);
  const setFacet = setFromTitle(title);
  const detectedLanguageFacet = languageFromDescriptor(descriptor.language || titleLanguage.language);
  const languageFacet = resolveLanguageFacet(detectedLanguageFacet, setFacet);
  const setLanguage = canonicalSetLanguage(setFacet);

  if (persisted) {
    const persistedConflictsWithSet = setLanguage
      && persisted.languageGroup !== "unknown"
      && persisted.languageGroup !== setLanguage.languageGroup;
    const currentConflict = languageFacet.source.startsWith("language_conflict:");

    if (persistedConflictsWithSet || currentConflict) {
      const conflict = currentConflict
        ? languageFacet
        : conflictLanguage(persisted.languageGroup, setLanguage.languageGroup, setFacet.setKey, `persisted_${persisted.source.language}`);
      return {
        ...persisted,
        languageGroup: conflict.languageGroup,
        languageCode: conflict.languageCode,
        languageLabel: "Unknown language",
        confidence: { ...persisted.confidence, language: conflict.confidence },
        source: { ...persisted.source, language: conflict.source },
      };
    }

    const improveLanguage = persisted.languageGroup === "unknown"
      && persisted.confidence.language === 0
      && (languageFacet.languageGroup !== "unknown" || currentConflict);
    const improveSet = !persisted.setKey
      && persisted.confidence.set === 0
      && Boolean(setFacet.setKey);
    if (!improveLanguage && !improveSet) return persisted;

    const languageGroup = improveLanguage ? languageFacet.languageGroup : persisted.languageGroup;
    return {
      ...persisted,
      languageGroup,
      languageCode: improveLanguage ? languageFacet.languageCode : persisted.languageCode,
      languageLabel: ALERT_LANGUAGE_GROUPS.find((group) => group.key === languageGroup)?.label || "Unknown language",
      setKey: improveSet ? setFacet.setKey : persisted.setKey,
      setName: improveSet ? setFacet.setName : persisted.setName,
      confidence: {
        ...persisted.confidence,
        language: improveLanguage ? languageFacet.confidence : persisted.confidence.language,
        set: improveSet ? setFacet.confidence : persisted.confidence.set,
      },
      source: {
        ...persisted.source,
        language: improveLanguage ? languageFacet.source : persisted.source.language,
        set: improveSet ? setFacet.source : persisted.source.set,
      },
    };
  }

  const marketFacet = marketResolution || persistedMarketResolution(entries) || {
    status: "unknown",
    marketCode: null,
    confidence: 0,
    source: "unknown",
  };
  const marketCode = ["verified", "reused"].includes(marketFacet.status) ? normalizeMarketCode(marketFacet.marketCode) : null;
  return {
    version: ALERT_FACET_VERSION,
    languageGroup: languageFacet.languageGroup,
    languageCode: languageFacet.languageCode,
    marketCode,
    marketGroup: marketGroupForCode(marketCode),
    marketStatus: marketFacet.status || "unknown",
    languageLabel: ALERT_LANGUAGE_GROUPS.find((group) => group.key === languageFacet.languageGroup)?.label || "Unknown language",
    setKey: setFacet.setKey,
    setName: setFacet.setName,
    confidence: { language: languageFacet.confidence, market: Number(marketFacet.confidence) || 0, set: setFacet.confidence },
    source: { language: languageFacet.source, market: marketFacet.source || "unknown", set: setFacet.source },
  };
}

export function alertFacetEvidence(facets, observedAt = Math.floor(Date.now() / 1000)) {
  return [{
    kind: "alert_facets",
    version: ALERT_FACET_VERSION,
    languageGroup: facets?.languageGroup || "unknown",
    languageCode: facets?.languageCode || null,
    marketCode: facets?.marketCode || null,
    marketGroup: facets?.marketGroup || "unknown",
    marketStatus: facets?.marketStatus || "unknown",
    languageConfidence: Number(facets?.confidence?.language) || 0,
    languageSource: facets?.source?.language || "unknown",
    marketConfidence: Number(facets?.confidence?.market) || 0,
    marketSource: facets?.source?.market || "unknown",
    setKey: facets?.setKey || null,
    setName: facets?.setName || null,
    setConfidence: Number(facets?.confidence?.set) || 0,
    setSource: facets?.source?.set || "unknown",
    observedAt,
  }];
}

export function listAlertFacetOptions() {
  return {
    version: ALERT_FACET_VERSION,
    languages: ALERT_LANGUAGE_GROUPS.map((group) => ({ ...group })),
    markets: ALERT_MARKET_GROUPS.map((group) => ({ ...group })),
    sets: [...SET_REGISTRY]
      .map(({ key, name }) => ({ key, name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}
