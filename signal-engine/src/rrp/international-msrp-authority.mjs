function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FX_SNAPSHOT = Object.freeze({
  JPY: { gbpPerUnit: 0.00460364, observedAt: "2026-08-25T13:08:00Z" },
  KRW: { gbpPerUnit: 0.000529851, observedAt: "2026-08-25T12:55:00Z" },
  CNY: { gbpPerUnit: 0.109095, observedAt: "2026-08-25T12:16:00Z" },
  TWD: { gbpPerUnit: 0.02304, observedAt: "2026-08-24T23:59:00Z" },
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

const AUTHORITIES = Object.freeze([
  // Japan — official Pokémon Card Game product catalogue / 2026 manufacturer price notice.
  { id: "jp-abyss-eye", market: "JP", currency: "JPY", aliases: ["abyss eye"], unitMsrp: 200, cardsPerPack: 5, sourceUrl: "https://www.pokemon-card.com/products/index.html?dateLowerM=1&dateUpperD=28&dateUpperM=5&dateUpperY=2026&productType=expansion", sourceObservedAt: "2026-05-22T00:00:00Z" },
  { id: "jp-ninja-spinner", market: "JP", currency: "JPY", aliases: ["ninja spinner"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: "https://www.pokemon-card.com/products/index.html?dateLowerM=1&dateUpperD=28&dateUpperM=5&dateUpperY=2026&productType=expansion", sourceObservedAt: "2026-03-13T00:00:00Z" },
  { id: "jp-nihil-zero", market: "JP", currency: "JPY", aliases: ["nihil zero", "nullifying zero"], unitMsrp: 180, cardsPerPack: 5, sourceUrl: "https://www.pokemon-card.com/products/index.html?dateLowerM=1&dateUpperD=28&dateUpperM=5&dateUpperY=2026&productType=expansion", sourceObservedAt: "2026-01-23T00:00:00Z" },
  { id: "jp-mega-dream-ex", market: "JP", currency: "JPY", aliases: ["mega dream ex", "mega dream"], unitMsrp: 550, cardsPerPack: 10, sourceUrl: "https://www.pokemon-card.com/products/index.html?dateLowerM=1&dateUpperD=28&dateUpperM=5&dateUpperY=2026&productType=expansion", sourceObservedAt: "2025-11-28T00:00:00Z" },

  // Korea — official Pokémon Card Korea product pages publish pack and box prices directly.
  { id: "kr-inferno-x", market: "KR", currency: "KRW", aliases: ["inferno x"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/838", sourceObservedAt: "2025-11-28T00:00:00Z" },
  { id: "kr-mega-symphonia", market: "KR", currency: "KRW", aliases: ["mega symphonia"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/815", sourceObservedAt: "2025-09-26T00:00:00Z" },
  { id: "kr-nihil-zero", market: "KR", currency: "KRW", aliases: ["nihil zero", "nullifying zero"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/869", sourceObservedAt: "2026-03-13T00:00:00Z" },
  { id: "kr-ninja-spinner", market: "KR", currency: "KRW", aliases: ["ninja spinner"], unitMsrp: 1000, boxMsrp: 30000, boxPacks: 30, cardsPerPack: 5, sourceUrl: "https://pokemoncard.co.kr/card/887", sourceObservedAt: "2026-05-01T00:00:00Z" },

  // Mainland China — official Pokémon China catalogue. Standard/slim 5-card packs are CN¥10,
  // jumbo/deluxe 20-card packs are CN¥50 for the mapped sets below; Gem packs are CN¥10.
  { id: "cn-blade-awakened", market: "CN", currency: "CNY", aliases: ["blade awakened"], formats: { standard: { unitMsrp: 10, cardsPerPack: 5 }, jumbo: { unitMsrp: 50, cardsPerPack: 20 } }, sourceUrl: "https://www.pokemon.cn/products_category/products/p/2", sourceObservedAt: "2026-01-16T00:00:00Z" },
  { id: "cn-brilliant-illusions", market: "CN", currency: "CNY", aliases: ["brilliant illusions"], formats: { standard: { unitMsrp: 10, cardsPerPack: 5 }, jumbo: { unitMsrp: 50, cardsPerPack: 20 } }, sourceUrl: "https://www.pokemon.cn/products_category/products/p/2", sourceObservedAt: "2026-03-13T00:00:00Z" },
  { id: "cn-chasing-glory-together", market: "CN", currency: "CNY", aliases: ["chasing glory together"], formats: { standard: { unitMsrp: 10, cardsPerPack: 5 }, jumbo: { unitMsrp: 50, cardsPerPack: 20 } }, sourceUrl: "https://www.pokemon.cn/products_category/products", sourceObservedAt: "2026-07-16T00:00:00Z" },
  { id: "cn-gem-1", market: "CN", currency: "CNY", aliases: ["gem 1", "gem vol 1"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: "https://www.pokemon.cn/tcg/product/15582.html", sourceObservedAt: "2025-01-17T00:00:00Z" },
  { id: "cn-gem-2", market: "CN", currency: "CNY", aliases: ["gem 2", "gem vol 2"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: "https://www.pokemon.cn/tcg/product/15518.html", sourceObservedAt: "2025-05-16T00:00:00Z" },
  { id: "cn-gem-3", market: "CN", currency: "CNY", aliases: ["gem 3", "gem vol 3"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: "https://www.pokemon.cn/tcg/product/15431.html", sourceObservedAt: "2025-09-26T00:00:00Z" },
  { id: "cn-gem-4", market: "CN", currency: "CNY", aliases: ["gem 4", "gem vol 4"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: "https://www.pokemon.cn/tcg/product/20382.html", sourceObservedAt: "2026-02-06T00:00:00Z" },
  { id: "cn-gem-5", market: "CN", currency: "CNY", aliases: ["gem 5", "gem vol 5"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: "https://www.pokemon.cn/tcg/product/21078.html", sourceObservedAt: "2026-04-24T00:00:00Z" },
  { id: "cn-gem-6", market: "CN", currency: "CNY", aliases: ["gem 6", "gem vol 6"], unitMsrp: 10, cardsPerPack: 4, sourceUrl: "https://www.pokemon.cn/products_category/products", sourceObservedAt: "2026-08-07T00:00:00Z" },

  // Traditional Chinese official Trainer sites. Region must be explicit because TWD and HKD differ.
  { id: "tw-abyss-eye", market: "TW", currency: "TWD", aliases: ["abyss eye"], unitMsrp: 54, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/tw/archives/12084/", sourceObservedAt: "2026-05-01T00:00:00Z" },
  { id: "tw-emerald-storm", market: "TW", currency: "TWD", aliases: ["emerald storm", "storm emerald"], unitMsrp: 54, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/tw/archive/special/card/m6/", sourceObservedAt: "2026-08-07T00:00:00Z" },
  { id: "hk-abyss-eye", market: "HK", currency: "HKD", aliases: ["abyss eye"], unitMsrp: 13, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/hk/archive/special/card/m5/", sourceObservedAt: "2026-06-05T00:00:00Z" },
  { id: "hk-emerald-storm", market: "HK", currency: "HKD", aliases: ["emerald storm", "storm emerald"], unitMsrp: 13, cardsPerPack: 5, sourceUrl: "https://asia.pokemon-card.com/hk/archive/special/card/m6/", sourceObservedAt: "2026-08-07T00:00:00Z" },
]);

function marketFromTitle(title = "") {
  const text = fold(title);
  if (/\b(?:japanese|japan|jpn)\b/.test(text)) return "JP";
  if (/\b(?:korean|korea)\b/.test(text)) return "KR";
  if (/\b(?:simplified chinese|chinese simplified)\b/.test(text)) return "CN";
  if (/\btraditional chinese\b/.test(text) && /\b(?:taiwan|tw)\b/.test(text)) return "TW";
  if (/\btraditional chinese\b/.test(text) && /\b(?:hong kong|hk)\b/.test(text)) return "HK";
  return null;
}

function quantityFromTitle(title = "") {
  const text = fold(title);
  for (const pattern of [
    /\b(\d{1,3})\s*x\s*(?:sealed\s+)?(?:booster\s+)?packs?\b/,
    /\b(\d{1,3})\s+(?:sealed\s+)?(?:booster\s+)?packs?\s+bundle\b/,
    /\b(\d{1,3})\s+pack\s+bundle\b/,
    /\bbox\s*\(\s*(\d{1,3})\s*(?:boosters?|packs?)\s*\)/,
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
  return AUTHORITIES.find((entry) => entry.market === market && entry.aliases.some((alias) => text.includes(fold(alias)))) || null;
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
  const market = marketFromTitle(title);
  if (!market) return { recognized: false, resolved: false, reason: "not_source_market_import" };
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
  const unitMsrp = Number(format?.unitMsrp);
  if (!Number.isFinite(unitMsrp) || unitMsrp <= 0) {
    return { recognized: true, resolved: false, reason: "source_market_msrp_invalid", sourceMarket: market };
  }

  const productType = input.productType || input.linkedProduct?.productType || "";
  const explicitQuantity = quantityFromTitle(title);
  let quantity = 1;
  let sourceMsrp = unitMsrp;
  let referenceKind = "source_market_msrp";

  if (productType === "booster_box") {
    if (Number.isFinite(authority.boxMsrp) && authority.boxMsrp > 0 && Number.isFinite(authority.boxPacks) && authority.boxPacks > 0) {
      quantity = authority.boxPacks;
      sourceMsrp = authority.boxMsrp;
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
  const sourceText = quantity > 1
    ? `${nativeLabel(sourceMsrp, authority.currency)} for ${quantity} comparable booster packs`
    : `${nativeLabel(sourceMsrp, authority.currency)} per booster pack`;

  return {
    recognized: true,
    resolved: true,
    kind: referenceKind,
    rrpPence,
    rrpSource: `official-msrp:${market.toLowerCase()}:${authority.sourceUrl}`,
    rrpObservedAt: epoch(authority.sourceObservedAt),
    unitCount: quantity,
    unitKind: "booster_pack",
    unitRrpPence,
    referenceBasis: `Official ${marketLabel} MSRP ${sourceText}; converted to GBP using FateDrop FX snapshot ${fx.observedAt.slice(0, 10)}. This is a source-market reference, not a UK RRP.`,
    matchedProductIds: [],
    referenceFamilyKey: `source-msrp:${authority.id}:${formatKey || "standard"}`,
    sourceMarket: market,
    sourceCurrency: authority.currency,
    sourceMsrp,
    sourceUnitMsrp: unitMsrp,
    sourceCardsPerPack: Number.isFinite(format.cardsPerPack) ? format.cardsPerPack : null,
    fxGbpPerUnit: fx.gbpPerUnit,
    fxObservedAt: epoch(fx.observedAt),
    sourceUrl: authority.sourceUrl,
  };
}

export const internationalMsrpFxSnapshot = FX_SNAPSHOT;
export const internationalMsrpAuthorities = AUTHORITIES;
