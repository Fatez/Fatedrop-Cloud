import { describeProductIdentity } from "./product-identity.mjs";
import { internationalMsrpAuthorities } from "../rrp/international-msrp-authority.mjs";

export const ALERT_FACET_VERSION = 1;

export const ALERT_LANGUAGE_GROUPS = Object.freeze([
  { key: "english", label: "English" },
  { key: "japanese", label: "Japanese" },
  { key: "korean", label: "Korean" },
  { key: "simplified_chinese", label: "Simplified Chinese" },
  { key: "traditional_chinese", label: "Traditional Chinese" },
  { key: "other", label: "Other languages" },
  { key: "unknown", label: "Unknown language" },
]);

const LANGUAGE_GROUP_KEYS = new Set(ALERT_LANGUAGE_GROUPS.map((group) => group.key));

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
  ["destined-rivals", "Destined Rivals", ["destined rivals"]],
  ["journey-together", "Journey Together", ["journey together"]],
  ["prismatic-evolutions", "Prismatic Evolutions", ["prismatic evolutions"]],
  ["surging-sparks", "Surging Sparks", ["surging sparks"]],
  ["stellar-crown", "Stellar Crown", ["stellar crown"]],
  ["shrouded-fable", "Shrouded Fable", ["shrouded fable"]],
  ["twilight-masquerade", "Twilight Masquerade", ["twilight masquerade"]],
  ["temporal-forces", "Temporal Forces", ["temporal forces"]],
  ["paldean-fates", "Paldean Fates", ["paldean fates"]],
  ["paradox-rift", "Paradox Rift", ["paradox rift"]],
  ["obsidian-flames", "Obsidian Flames", ["obsidian flames"]],
  ["paldea-evolved", "Paldea Evolved", ["paldea evolved"]],
  ["pokemon-151", "Pokémon 151", ["pokemon 151", "scarlet and violet 151", "scarlet violet 151"]],
  ["black-bolt", "Black Bolt", ["black bolt"]],
  ["white-flare", "White Flare", ["white flare"]],
  ["mega-evolution", "Mega Evolution", ["mega evolution"]],
  ["phantasmal-flames", "Phantasmal Flames", ["phantasmal flames"]],
  ["perfect-order", "Perfect Order", ["perfect order"]],
  ["chaos-rising", "Chaos Rising", ["chaos rising"]],
  ["crown-zenith", "Crown Zenith", ["crown zenith"]],
  ["silver-tempest", "Silver Tempest", ["silver tempest"]],
  ["lost-origin", "Lost Origin", ["lost origin"]],
  ["astral-radiance", "Astral Radiance", ["astral radiance"]],
  ["brilliant-stars", "Brilliant Stars", ["brilliant stars"]],
  ["fusion-strike", "Fusion Strike", ["fusion strike"]],
  ["evolving-skies", "Evolving Skies", ["evolving skies"]],
  ["chilling-reign", "Chilling Reign", ["chilling reign"]],
];

const INTERNATIONAL_ALIAS_FAMILIES = [
  ["team-rocket-glory", "Team Rocket Glory", ["team rocket glory", "glory of team rocket"]],
  ["emerald-storm", "Emerald Storm", ["emerald storm", "storm emerald"]],
  ["mega-dream-ex", "Mega Dream ex", ["mega dream ex", "mega dream"]],
  ["nihil-zero", "Nihil Zero", ["nihil zero", "nullifying zero"]],
  ["pokemon-151", "Pokémon 151", ["pokemon card 151", "pokemon 151"]],
  ["terastal-festival-ex", "Terastal Festival ex", ["terastal festival ex", "terastal festival"]],
  ["gem-1", "Gem Vol. 1", ["gem vol 1", "gem 1"]],
  ["gem-2", "Gem Vol. 2", ["gem vol 2", "gem 2"]],
  ["gem-3", "Gem Vol. 3", ["gem vol 3", "gem 3"]],
  ["gem-4", "Gem Vol. 4", ["gem vol 4", "gem 4"]],
  ["gem-5", "Gem Vol. 5", ["gem vol 5", "gem 5"]],
  ["gem-6", "Gem Vol. 6", ["gem vol 6", "gem 6"]],
];

function authoritySetFamilies() {
  return internationalMsrpAuthorities.flatMap((authority) => {
    if (Number.isFinite(authority?.directMsrp)) return [];
    const aliases = [...new Set((authority?.aliases || []).map(fold).filter(Boolean))];
    if (!aliases.length) return [];
    const authorityKey = String(authority.id || "").replace(/^(?:jp|kr|cn|tw|hk)-/, "");
    return [[authorityKey || slug(aliases[0]), titleCase(aliases[0]), aliases]];
  });
}

function buildSetRegistry() {
  const byKey = new Map();
  for (const [key, name, aliases] of [
    ...ENGLISH_SET_FAMILIES,
    ...INTERNATIONAL_ALIAS_FAMILIES,
    ...authoritySetFamilies(),
  ]) {
    const safeKey = slug(key);
    if (!safeKey) continue;
    const existing = byKey.get(safeKey);
    byKey.set(safeKey, {
      key: safeKey,
      name: existing?.name || name,
      aliases: [...new Set([...(existing?.aliases || []), ...(aliases || []).map(fold)].filter(Boolean))],
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

function evidenceValue(entries, kind) {
  const value = entries.find((entry) => entry?.kind === kind)?.value;
  return value == null ? null : String(value).trim() || null;
}

function persistedFacets(entries) {
  const entry = entries.find((candidate) => candidate?.kind === "alert_facets" && candidate?.version === ALERT_FACET_VERSION);
  if (!entry || !LANGUAGE_GROUP_KEYS.has(entry.languageGroup)) return null;
  return {
    version: ALERT_FACET_VERSION,
    languageGroup: entry.languageGroup,
    languageCode: typeof entry.languageCode === "string" && entry.languageCode ? entry.languageCode : null,
    marketCode: typeof entry.marketCode === "string" && entry.marketCode ? entry.marketCode : null,
    languageLabel: ALERT_LANGUAGE_GROUPS.find((group) => group.key === entry.languageGroup)?.label || "Unknown language",
    setKey: typeof entry.setKey === "string" && entry.setKey ? entry.setKey : null,
    setName: typeof entry.setName === "string" && entry.setName ? entry.setName : null,
    confidence: {
      language: Number.isFinite(Number(entry.languageConfidence)) ? Number(entry.languageConfidence) : 0,
      set: Number.isFinite(Number(entry.setConfidence)) ? Number(entry.setConfidence) : 0,
    },
    source: {
      language: typeof entry.languageSource === "string" ? entry.languageSource : "persisted",
      set: typeof entry.setSource === "string" ? entry.setSource : entry.setKey ? "persisted" : "unknown",
    },
  };
}

function languageFromDescriptor(language, region, sourceMarket, retailerCountryCode) {
  const normalizedLanguage = language == null ? "" : fold(language).replace(/\s+/g, "_");
  const normalizedRegion = String(region || "").trim().toUpperCase();
  const normalizedMarket = String(sourceMarket || "").trim().toUpperCase();

  if (["japanese", "ja", "jp", "jpn"].includes(normalizedLanguage) || normalizedRegion === "JP" || normalizedMarket === "JP") {
    return { languageGroup: "japanese", languageCode: "ja", marketCode: "JP", confidence: 1, source: normalizedLanguage ? "explicit_language" : "source_market" };
  }
  if (["korean", "ko", "kr"].includes(normalizedLanguage) || normalizedRegion === "KR" || normalizedMarket === "KR") {
    return { languageGroup: "korean", languageCode: "ko", marketCode: "KR", confidence: 1, source: normalizedLanguage ? "explicit_language" : "source_market" };
  }
  if (["simplified_chinese", "zh_hans", "zh_cn", "zh-cn", "cn"].includes(normalizedLanguage) || normalizedRegion === "CN" || normalizedMarket === "CN") {
    return { languageGroup: "simplified_chinese", languageCode: "zh-Hans", marketCode: "CN", confidence: 1, source: normalizedLanguage ? "explicit_language" : "source_market" };
  }
  if (["traditional_chinese", "zh_hant", "zh_tw", "zh_hk", "zh-tw", "zh-hk", "tw", "hk"].includes(normalizedLanguage)
    || ["TW", "HK"].includes(normalizedRegion) || ["TW", "HK"].includes(normalizedMarket)) {
    const marketCode = ["TW", "HK"].includes(normalizedRegion) ? normalizedRegion : ["TW", "HK"].includes(normalizedMarket) ? normalizedMarket : null;
    return { languageGroup: "traditional_chinese", languageCode: "zh-Hant", marketCode, confidence: marketCode ? 1 : 0.9, source: normalizedLanguage ? "explicit_language" : "source_market" };
  }
  if (["english", "en", "gb", "uk"].includes(normalizedLanguage)) {
    return { languageGroup: "english", languageCode: "en", marketCode: normalizedRegion || "GB", confidence: 1, source: "explicit_language" };
  }
  if (normalizedLanguage === "chinese_unspecified" || normalizedLanguage === "chinese") {
    return { languageGroup: "unknown", languageCode: null, marketCode: null, confidence: 0.4, source: "ambiguous_chinese_marker" };
  }
  if (normalizedLanguage) {
    return { languageGroup: "other", languageCode: normalizedLanguage.replaceAll("_", "-"), marketCode: normalizedRegion || null, confidence: 0.95, source: "explicit_language" };
  }
  if (String(retailerCountryCode || "").trim().toUpperCase() === "GB") {
    return { languageGroup: "english", languageCode: "en", marketCode: "GB", confidence: 0.72, source: "uk_catalogue_default" };
  }
  return { languageGroup: "unknown", languageCode: null, marketCode: null, confidence: 0, source: "unknown" };
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
  if (!normalized) return { setKey: null, setName: null, confidence: 0, source: "unknown" };
  const padded = ` ${normalized} `;
  for (const family of SET_REGISTRY) {
    const matched = family.aliases.find((alias) => padded.includes(` ${alias} `));
    if (!matched) continue;
    return { setKey: family.key, setName: family.name, confidence: 1, source: `title_alias:${matched}` };
  }
  return { setKey: null, setName: null, confidence: 0, source: "unknown" };
}

export function deriveAlertFacets({ title = "", language = null, region = null, retailerCountryCode = null, evidence = [] } = {}) {
  const entries = evidenceEntries(evidence);
  const persisted = persistedFacets(entries);
  if (persisted) return persisted;

  const descriptor = describeProductIdentity({ title, language, region });
  const titleLanguage = explicitTitleLanguage(title);
  const sourceMarket = evidenceValue(entries, "rrp_source_market");
  const languageFacet = languageFromDescriptor(
    descriptor.language || titleLanguage.language,
    descriptor.region || titleLanguage.region,
    sourceMarket,
    retailerCountryCode,
  );
  const setFacet = setFromTitle(title);
  return {
    version: ALERT_FACET_VERSION,
    languageGroup: languageFacet.languageGroup,
    languageCode: languageFacet.languageCode,
    marketCode: languageFacet.marketCode,
    languageLabel: ALERT_LANGUAGE_GROUPS.find((group) => group.key === languageFacet.languageGroup)?.label || "Unknown language",
    setKey: setFacet.setKey,
    setName: setFacet.setName,
    confidence: { language: languageFacet.confidence, set: setFacet.confidence },
    source: { language: languageFacet.source, set: setFacet.source },
  };
}

export function alertFacetEvidence(facets, observedAt = Math.floor(Date.now() / 1000)) {
  return [{
    kind: "alert_facets",
    version: ALERT_FACET_VERSION,
    languageGroup: facets?.languageGroup || "unknown",
    languageCode: facets?.languageCode || null,
    marketCode: facets?.marketCode || null,
    languageConfidence: Number(facets?.confidence?.language) || 0,
    languageSource: facets?.source?.language || "unknown",
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
    sets: [...SET_REGISTRY]
      .map(({ key, name }) => ({ key, name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}
