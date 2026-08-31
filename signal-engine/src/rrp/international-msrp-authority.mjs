function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Dated FX evidence converts the authoritative native MSRP into the GBP reference
// used by Fate Verdict. The native MSRP remains the authority; this snapshot is
// intentionally auditable and must not be described as a UK RRP.
const FX_SNAPSHOT = Object.freeze({
  JPY: { gbpPerUnit: 0.00460364, observedAt: "2026-08-25T13:08:00Z" },
  KRW: { gbpPerUnit: 0.000529851, observedAt: "2026-08-25T12:55:00Z" },
  CNY: { gbpPerUnit: 0.109095, observedAt: "2026-08-25T12:16:00Z" },
  TWD: { gbpPerUnit: 0.0230126, observedAt: "2026-08-25T00:00:00Z" },
  HKD: { gbpPerUnit: 0.0935715, observedAt: "2026-08-25T12:16:00Z" },
});

const MARKET_LABEL = Object.freeze({
  JP: "Japan",
  KR: "Korea",
  CN: "Mainland China",
  TW: "Taiwan",
  HK: "Hong Kong",
});

const CURRENCY_SYMBOL = Object.freeze({
  JPY: "¥",
  KRW: "₩",
  CNY: "CN¥",
  TWD: "NT$",
  HKD: "HK$",
});

const JP_CATALOGUE = "https://www.pokemon-card.com/products/index.html";
const CN_CATALOGUE = "https://www.pokemon.cn/products_category/products";

const AUTHORITIES = Object.freeze([
  // Japan — exact manufacturer suggested retail prices from Pokémon Card Game Japan.
  // Historical pre-tax pages are represented at the tax-inclusive consumer MSRP
  // applicable on their release date, and retain the official manufacturer URL.
  { id: "jp-pokemon-center-fukuoka-special-box", market: "JP", currency: "JPY", aliases: ["pokemon center fukuoka special box", "fukuoka special box"], directMsrp: 2090, directProductTypes: ["collection_box", "other"], sourceUrl: "https://www.pokemon-card.com/info/005053.html", sourceObservedAt: "2025-06-13T00:00:00Z" },
  { id: "jp-premium-trainer-box-mega", market: "JP", currency: "JPY", aliases: ["premium trainer box mega", "premium trainer box"], directMsrp: 6350, directProductTypes: ["collection_box", "other"], sourceUrl: "https://www.pokemon-card.com/ex/m1/", sourceObservedAt: "2025-08-01T00:00:00Z" },
  { id: "jp-tag-team-gx-all-stars", market: "JP", currency: "JPY", aliases: ["tag team gx all stars", "tag team all stars", "tag all stars"], unitMsrp: 550, boxPacks: 10, cardsPerPack: 11, sourceUrl: "https://www.pokemon-card.com/ex/sm12a/index.html", packagingSourceUrl: "https://www.plazajapan.com/blog/the-sun-moon-era-signs-off-in-style-with-tag-all-stars/", sourceObservedAt: "2019-10-04T00:00:00Z", priceBasisNote: "The official launch MSRP was ¥500 plus tax; ¥550 is the tax-inclusive release reference." },
  { id: "jp-remix-bout", market: "JP", currency: "JPY", aliases: ["remix bout"], unitMsrp: 162, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://www.pokemon-card.com/ex/sm11a/index.html", packagingSourceUrl: "https://www.discovery-japan.me/category/select/pid/23651/language/en/currency/GBP", sourceObservedAt: "2019-07-05T00:00:00Z", priceBasisNote: "The official launch MSRP was ¥150 plus tax; ¥162 is the tax-inclusive release reference." },
  { id: "jp-legendary-heartbeat", market: "JP", currency: "JPY", aliases: ["legendary heartbeat"], unitMsrp: 253, boxPacks: 20, cardsPerPack: 7, sourceUrl: "https://www.pokemon-card.com/products/s/s3a.html", packagingSourceUrl: "https://stockx.com/2020-pokemon-tcg-sword-shield-s3a-legendary-heartbeat-booster-box", sourceObservedAt: "2020-07-10T00:00:00Z" },
  { id: "jp-vmax-rising", market: "JP", currency: "JPY", aliases: ["vmax rising"], unitMsrp: 165, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://www.pokemon-card.com/products/s/s1a.html", packagingSourceUrl: "https://www.pokemon-card.com/products/s/s1a.html", sourceObservedAt: "2020-02-07T00:00:00Z" },
  { id: "jp-abyss-eye", market: "JP", currency: "JPY", aliases: ["abyss eye"], unitMsrp: 200, cardsPerPack: 5, sourceUrl: "https://www.pokemon-card.com/ex/m5/", sourceObservedAt: "2026-05-22T00:00:00Z" },
  { id: "jp-emerald-storm", market: "JP", currency: "JPY", aliases: ["emerald storm", "storm emerald"], unitMsrp: 200, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2026-07-31T00:00:00Z" },
  { id: "jp-ninja-spinner", market: "JP", currency: "JPY", aliases: ["ninja spinner"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2026-03-13T00:00:00Z" },
  { id: "jp-nihil-zero", market: "JP", currency: "JPY", aliases: ["nihil zero", "nullifying zero"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2026-01-23T00:00:00Z" },
  { id: "jp-mega-dream-ex", market: "JP", currency: "JPY", aliases: ["mega dream ex", "mega dream"], unitMsrp: 550, cardsPerPack: 10, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2025-11-28T00:00:00Z" },
  { id: "jp-inferno-x", market: "JP", currency: "JPY", aliases: ["inferno x"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2025-09-26T00:00:00Z" },
  { id: "jp-mega-brave", market: "JP", currency: "JPY", aliases: ["mega brave"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2025-08-01T00:00:00Z" },
  { id: "jp-mega-symphonia", market: "JP", currency: "JPY", aliases: ["mega symphonia"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2025-08-01T00:00:00Z" },
  { id: "jp-team-rocket-glory", market: "JP", currency: "JPY", aliases: ["glory of team rocket", "team rocket glory"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: JP_CATALOGUE, sourceObservedAt: "2025-04-18T00:00:00Z" },

  // Korea — official Pokémon Card Korea pages publish pack and box prices.
  { id: "kr-pokemon-151", market: "KR", currency: "KRW", aliases: ["pokemon card 151", "pokemon 151"], unitMsrp: 2500, boxMsrp: 50000, boxPacks: 20, cardsPerPack: 7, sourceUrl: "https://pokemoncard.co.kr/card/551", sourceObservedAt: "2023-07-28T00:00:00Z" },
  { id: "kr-terastal-festival-ex", market: "KR", currency: "KRW", aliases: ["terastal festival ex", "terastal festival"], unitMsrp: 5000, boxMsrp: 50000, boxPacks: 10, cardsPerPack: 10, sourceUrl: "https://pokemoncard.co.kr/card/708", sourceObservedAt: "2024-12-27T00:00:00Z" },
  { id: "kr-battle-partners", market: "KR", currency: "KRW", aliases: ["battle partners"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/731", sourceObservedAt: "2025-03-21T00:00:00Z" },
  { id: "kr-heat-wave-arena", market: "KR", currency: "KRW", aliases: ["heat wave arena"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/772", sourceObservedAt: "2025-05-16T00:00:00Z" },
  { id: "kr-team-rocket-glory", market: "KR", currency: "KRW", aliases: ["glory of team rocket", "team rocket glory"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/785", sourceObservedAt: "2025-06-20T00:00:00Z" },
  { id: "kr-inferno-x", market: "KR", currency: "KRW", aliases: ["inferno x"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/838", sourceObservedAt: "2025-11-28T00:00:00Z" },
  { id: "kr-mega-symphonia", market: "KR", currency: "KRW", aliases: ["mega symphonia"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/815", sourceObservedAt: "2025-09-26T00:00:00Z" },
  { id: "kr-nihil-zero", market: "KR", currency: "KRW", aliases: ["nihil zero", "nullifying zero"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/869", sourceObservedAt: "2026-03-13T00:00:00Z" },
  { id: "kr-ninja-spinner", market: "KR", currency: "KRW", aliases: ["ninja spinner"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/887", sourceObservedAt: "2026-05-01T00:00:00Z" },

  // Mainland China — official Pokémon China suggested retail prices. Sets with
  // multiple card-count pack formats stay separate value families.
  { id: "cn-terastal-grand-gathering", market: "CN", currency: "CNY", aliases: ["terastal grand gathering"], unitMsrp: 30, cardsPerPack: 10, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2026-06-12T00:00:00Z" },
  { id: "cn-blade-awakened", market: "CN", currency: "CNY", aliases: ["blade awakened"], formats: { standard: { unitMsrp: 10, cardsPerPack: 5 }, jumbo: { unitMsrp: 50, cardsPerPack: 20 } }, sourceUrl: "https://www.pokemon.cn/tcg/product/19812.html", sourceObservedAt: "2026-01-16T00:00:00Z" },
  { id: "cn-brilliant-illusions", market: "CN", currency: "CNY", aliases: ["brilliant illusions"], formats: { standard: { unitMsrp: 10, cardsPerPack: 5 }, jumbo: { unitMsrp: 50, cardsPerPack: 20 } }, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2026-03-13T00:00:00Z" },
  { id: "cn-chasing-glory-together", market: "CN", currency: "CNY", aliases: ["chasing glory together"], formats: { standard: { unitMsrp: 10, cardsPerPack: 5 }, jumbo: { unitMsrp: 50, cardsPerPack: 20 } }, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2026-07-16T00:00:00Z" },
  { id: "cn-gem-1", market: "CN", currency: "CNY", aliases: ["gem 1", "gem vol 1"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2025-01-17T00:00:00Z" },
  { id: "cn-gem-2", market: "CN", currency: "CNY", aliases: ["gem 2", "gem vol 2"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2025-05-16T00:00:00Z" },
  { id: "cn-gem-3", market: "CN", currency: "CNY", aliases: ["gem 3", "gem vol 3"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2025-09-26T00:00:00Z" },
  { id: "cn-gem-4", market: "CN", currency: "CNY", aliases: ["gem 4", "gem vol 4"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2026-02-06T00:00:00Z" },
  { id: "cn-gem-5", market: "CN", currency: "CNY", aliases: ["gem 5", "gem vol 5"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2026-04-24T00:00:00Z" },
  { id: "cn-gem-6", market: "CN", currency: "CNY", aliases: ["gem 6", "gem vol 6"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: CN_CATALOGUE, sourceObservedAt: "2026-08-07T00:00:00Z" },

  // Traditional Chinese authority is region-specific. A title must identify Taiwan
  // or Hong Kong; plain "Traditional Chinese" deliberately fails closed.
  { id: "tw-abyss-eye", market: "TW", currency: "TWD", aliases: ["abyss eye"], unitMsrp: 54, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/tw/archives/12084/", sourceObservedAt: "2026-05-22T00:00:00Z" },
  { id: "tw-emerald-storm", market: "TW", currency: "TWD", aliases: ["emerald storm", "storm emerald"], unitMsrp: 54, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/tw/archives/12084/", sourceObservedAt: "2026-08-07T00:00:00Z" },
  { id: "hk-abyss-eye", market: "HK", currency: "HKD", aliases: ["abyss eye"], unitMsrp: 13, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/hk/archive/special/card/m5/", sourceObservedAt: "2026-06-05T00:00:00Z" },
  { id: "hk-emerald-storm", market: "HK", currency: "HKD", aliases: ["emerald storm", "storm emerald"], unitMsrp: 13, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/hk/archive/special/card/m6/", sourceObservedAt: "2026-08-07T00:00:00Z" },
]);

function importIdentityFromTitle(title = "") {
  const text = fold(title);
  if (/\b(?:japanese|japan|jpn)\b/.test(text)) return { recognized: true, market: "JP" };
  if (/\b(?:korean|korea)\b/.test(text)) return { recognized: true, market: "KR" };
  if (/\b(?:simplified chinese|chinese simplified)\b/.test(text)) return { recognized: true, market: "CN" };
  if (/\btraditional chinese\b/.test(text) && /\b(?:taiwan|tw)\b/.test(text)) return { recognized: true, market: "TW" };
  if (/\btraditional chinese\b/.test(text) && /\b(?:hong kong|hk)\b/.test(text)) return { recognized: true, market: "HK" };
  if (/\b(?:traditional chinese|chinese)\b/.test(text)) return { recognized: true, market: null };
  return { recognized: false, market: null };
}

function quantityFromTitle(title = "") {
  const text = fold(title);
  for (const pattern of [
    /\b(\d{1,3})\s*x\s*(?:sealed\s+)?(?:booster\s+)?packs?\b/,
    /\b(\d{1,3})\s+(?:sealed\s+)?(?:booster\s+)?packs?\s+bundle\b/,
    /\b(\d{1,3})\s+pack\s+bundle\b/,
    /\bbox\s*\(\s*(\d{1,3})\s*(?:boosters?|packs?)\s*\)/,
    /\b\(\s*(\d{1,3})\s*(?:boosters?|packs?)\s*\)/,
    /\b(\d{1,3})\s*(?:boosters?|packs?)\b/,
  ]) {
    const match = text.match(pattern);
    if (!match) continue;
    const quantity = Number.parseInt(match[1], 10);
    if (Number.isFinite(quantity) && quantity > 0 && quantity <= 100) return quantity;
  }
  return null;
}

function formatKeyFor(authority, title = "") {
  if (!authority.formats) return "standard";
  const text = fold(title);
  if (/\b(?:jumbo|deluxe)\b/.test(text)) return "jumbo";
  if (/\b(?:slim|standard)\b/.test(text)) return "standard";
  return null;
}

function authorityFor(market, title = "") {
  const text = fold(title);
  const matches = AUTHORITIES.flatMap((entry) => {
    if (entry.market !== market) return [];
    const matchedAliases = entry.aliases.filter((alias) => text.includes(fold(alias)));
    if (!matchedAliases.length) return [];
    const specificity = Math.max(...matchedAliases.map((alias) => fold(alias).length));
    return [{ entry, specificity }];
  });
  matches.sort((left, right) => right.specificity - left.specificity || left.entry.id.localeCompare(right.entry.id));
  return matches[0]?.entry || null;
}

function nativeLabel(amount, currency) {
  const symbol = CURRENCY_SYMBOL[currency] || `${currency} `;
  return `${symbol}${Number(amount).toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
}

function toGbpPence(amount, currency) {
  const fx = FX_SNAPSHOT[currency];
  if (!fx || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * fx.gbpPerUnit * 100);
}

function epoch(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function resolveInternationalMsrp(input = {}) {
  const title = String(input.title || input.linkedProduct?.title || "");
  const text = fold(title);
  const importIdentity = importIdentityFromTitle(title);
  const rememberedMarket = ["GB", "US", "CA", "AU", "NZ", "IE", "JP", "KR", "CN", "TW", "HK"]
    .includes(String(input.verifiedMarketCode || "").toUpperCase())
    ? String(input.verifiedMarketCode).toUpperCase()
    : null;
  if (input.marketResolutionStatus === "conflict") {
    return { recognized: true, resolved: false, reason: "source_market_memory_conflict", sourceMarket: null };
  }
  if (!importIdentity.recognized && !rememberedMarket) return { recognized: false, resolved: false, reason: "not_source_market_import" };
  if (importIdentity.market && rememberedMarket && importIdentity.market !== rememberedMarket) {
    return { recognized: true, resolved: false, reason: "source_market_memory_conflict", sourceMarket: null };
  }
  const market = rememberedMarket || importIdentity.market;
  if (!market) return { recognized: true, resolved: false, reason: "source_market_region_unresolved", sourceMarket: null };

  if (/\bopened live(?: on stream)?\b/.test(text)) {
    return { recognized: true, resolved: false, reason: "source_market_opened_live_not_comparable", sourceMarket: market };
  }
  if (/\bmystery\b/.test(text)) {
    return { recognized: true, resolved: false, reason: "source_market_identity_insufficient", sourceMarket: market };
  }

  const authority = authorityFor(market, title);
  if (!authority) return { recognized: true, resolved: false, reason: "no_verified_source_market_msrp", sourceMarket: market };

  const formatKey = formatKeyFor(authority, title);
  if (authority.formats && !formatKey) {
    return { recognized: true, resolved: false, reason: "source_market_pack_format_unresolved", sourceMarket: market };
  }
  const format = authority.formats ? authority.formats[formatKey] : authority;
  const productType = input.productType || input.linkedProduct?.productType || "";
  const directMsrp = Number(authority.directMsrp);
  const isDirectProduct = Number.isFinite(directMsrp) && directMsrp > 0;
  let unitMsrp = isDirectProduct ? directMsrp : Number(format?.unitMsrp);
  if (!Number.isFinite(unitMsrp) || unitMsrp <= 0) {
    return { recognized: true, resolved: false, reason: "source_market_msrp_invalid", sourceMarket: market };
  }

  const explicitQuantity = quantityFromTitle(title);
  let quantity = 1;
  let sourceMsrp = unitMsrp;
  let referenceKind = "source_market_msrp";
  let referenceUnitKind = "booster_pack";

  if (isDirectProduct) {
    const allowedTypes = Array.isArray(authority.directProductTypes) ? authority.directProductTypes : [];
    if (allowedTypes.length && !allowedTypes.includes(productType)) {
      return { recognized: true, resolved: false, reason: "source_market_configuration_unverified", sourceMarket: market };
    }
    sourceMsrp = directMsrp;
    unitMsrp = directMsrp;
    quantity = 1;
    referenceUnitKind = productType || "product";
  } else if (productType === "booster_box") {
    if (Number.isFinite(authority.boxMsrp) && authority.boxMsrp > 0 && Number.isFinite(authority.boxPacks) && authority.boxPacks > 0) {
      quantity = authority.boxPacks;
      sourceMsrp = authority.boxMsrp;
    } else if (Number.isFinite(authority.boxPacks) && authority.boxPacks > 0) {
      quantity = authority.boxPacks;
      sourceMsrp = unitMsrp * quantity;
      referenceKind = "source_market_component_reference";
    } else if (explicitQuantity) {
      quantity = explicitQuantity;
      sourceMsrp = unitMsrp * quantity;
      referenceKind = "source_market_component_reference";
    } else {
      return { recognized: true, resolved: false, reason: "source_market_box_quantity_unverified", sourceMarket: market };
    }
  } else if (productType === "booster_pack") {
    if (explicitQuantity && /\b(?:bundle|\d+\s*x)\b/.test(text)) {
      quantity = explicitQuantity;
      sourceMsrp = unitMsrp * quantity;
      referenceKind = "source_market_component_reference";
    }
  } else if (explicitQuantity && /\b(?:bundle|packs?)\b/.test(text)) {
    quantity = explicitQuantity;
    sourceMsrp = unitMsrp * quantity;
    referenceKind = "source_market_component_reference";
  } else {
    return { recognized: true, resolved: false, reason: "source_market_configuration_unverified", sourceMarket: market };
  }

  const rrpPence = toGbpPence(sourceMsrp, authority.currency);
  const unitRrpPence = toGbpPence(unitMsrp, authority.currency);
  const fx = FX_SNAPSHOT[authority.currency];
  if (!Number.isFinite(rrpPence) || !Number.isFinite(unitRrpPence) || !fx) {
    return { recognized: true, resolved: false, reason: "source_market_fx_unavailable", sourceMarket: market };
  }

  const marketLabel = MARKET_LABEL[market] || market;
  const sourceText = isDirectProduct
    ? `${nativeLabel(sourceMsrp, authority.currency)} for the complete product`
    : quantity > 1
      ? `${nativeLabel(sourceMsrp, authority.currency)} for ${quantity} comparable booster packs`
      : `${nativeLabel(sourceMsrp, authority.currency)} per booster pack`;
  const priceBasisNote = authority.priceBasisNote ? ` ${authority.priceBasisNote}` : "";
  const referenceFamilyKey = `source-msrp:${authority.id}:${formatKey || "standard"}`;

  return {
    recognized: true,
    resolved: true,
    kind: referenceKind,
    rrpPence,
    rrpSource: `official-msrp:${market.toLowerCase()}:${authority.id}:${formatKey || "standard"}:${authority.sourceUrl}`,
    rrpObservedAt: epoch(authority.sourceObservedAt),
    unitCount: quantity,
    unitKind: referenceUnitKind,
    unitRrpPence,
    referenceBasis: `Official ${marketLabel} MSRP ${sourceText}.${priceBasisNote} Converted to GBP using FateDrop FX snapshot ${fx.observedAt.slice(0, 10)}. This is a source-market reference, not a UK RRP.`,
    // Current value-family plumbing keys off matchedProductIds. This names the
    // external authority explicitly and cannot collide with prd_* product IDs.
    matchedProductIds: [`external-reference:${referenceFamilyKey}`],
    referenceFamilyKey,
    sourceMarket: market,
    sourceCurrency: authority.currency,
    sourceMsrp,
    sourceUnitMsrp: unitMsrp,
    sourceCardsPerPack: isDirectProduct ? null : (Number.isFinite(format.cardsPerPack) ? format.cardsPerPack : null),
    fxGbpPerUnit: fx.gbpPerUnit,
    fxObservedAt: epoch(fx.observedAt),
    sourceUrl: authority.sourceUrl,
    sourcePackagingUrl: authority.packagingSourceUrl || null,
    authorityId: authority.id,
  };
}

export const internationalMsrpFxSnapshot = FX_SNAPSHOT;
export const internationalMsrpAuthorities = AUTHORITIES;
