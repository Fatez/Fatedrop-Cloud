import { ADAPTER_TYPES, RETAILER_CLASSES, RETAILER_STATES, RRP_AUTHORITY, VERIFICATION_STATES } from "./registry.mjs";

const DISCOVERED_AT = "2026-08-21T00:50:00.000Z";

function internationalCandidate({ id, name, websiteUrl, catalogueUrl, tcgs = ["pokemon"], countryCode, currency, shippingSourceUrl, evidence = [] }) {
  return {
    id,
    name,
    websiteUrl,
    countryCode,
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    adapterType: ADAPTER_TYPES.GENERIC_HTML,
    state: RETAILER_STATES.CANDIDATE,
    verification: VERIFICATION_STATES.UNVERIFIED,
    rrpAuthority: RRP_AUTHORITY.NONE,
    tcgs,
    catalogue: { urls: [catalogueUrl] },
    delivery: {
      known: false,
      shipsToUk: true,
      currency,
      sourceUrl: shippingSourceUrl,
      observedAt: DISCOVERED_AT,
      dutiesIncluded: null,
      importFeesKnown: false,
    },
    discovery: {
      source: "manual-research",
      discoveredAt: DISCOVERED_AT,
      evidence: [
        ...evidence,
        "International candidate only. UK shipping is evidenced, but live monitoring remains blocked until FateDrop supports FX, VAT, duties and landed-cost conversion.",
      ],
    },
  };
}

export const internationalUkAccessibleRetailers20260821 = [
  internationalCandidate({
    id: "plaza-japan",
    name: "Plaza Japan",
    websiteUrl: "https://www.plazajapan.com/",
    catalogueUrl: "https://www.plazajapan.com/pokemon/",
    countryCode: "JP",
    currency: "JPY",
    shippingSourceUrl: "https://www.plazajapan.com/ordering-information/",
    evidence: ["Retailer-owned ordering information documents VAT handling specifically for United Kingdom customers, and its Pokemon store advertises international shipping from Japan."],
  }),
  internationalCandidate({
    id: "meccha-japan",
    name: "Meccha Japan",
    websiteUrl: "https://meccha-japan.com/",
    catalogueUrl: "https://meccha-japan.com/en/1322-pokemon-tcg",
    countryCode: "JP",
    currency: "JPY",
    shippingSourceUrl: "https://meccha-japan.com/en/1322-pokemon-tcg",
    evidence: ["Retailer-owned Pokemon TCG catalogue sells booster boxes and other Pokemon Card Game products; product pages advertise Shipping Worldwide."],
  }),
  internationalCandidate({
    id: "hobby-genki",
    name: "Hobby Genki",
    websiteUrl: "https://hobby-genki.com/",
    catalogueUrl: "https://hobby-genki.com/en/110-trading-cards",
    countryCode: "JP",
    currency: "JPY",
    shippingSourceUrl: "https://hobby-genki.com/en/110-trading-cards",
    tcgs: ["pokemon", "one-piece", "yugioh", "digimon", "dragon-ball", "magic", "union-arena"],
    evidence: ["Retailer-owned trading-card catalogue states authentic Japanese TCG/OCG products are shipped worldwide from Osaka and includes Pokemon booster boxes."],
  }),
];
