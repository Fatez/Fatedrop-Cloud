import { ADAPTER_TYPES, RETAILER_CLASSES, RETAILER_STATES, RRP_AUTHORITY, VERIFICATION_STATES } from "./registry.mjs";

const DISCOVERED_AT = "2026-08-21T00:36:00.000Z";

function shopifyCandidate({ id, name, websiteUrl, tcgs = ["pokemon"], retailerClass = RETAILER_CLASSES.INDEPENDENT, catalogueUrl = null, evidence = [] }) {
  return {
    id,
    name,
    websiteUrl,
    retailerClass,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.CANDIDATE,
    verification: VERIFICATION_STATES.UNVERIFIED,
    rrpAuthority: RRP_AUTHORITY.NONE,
    tcgs,
    catalogue: {
      urls: [catalogueUrl || websiteUrl],
      feedUrl: new URL("/products.json?limit=250", websiteUrl).toString(),
      feedApproved: false,
      platformEvidence: ["public-site-footer:powered-by-shopify"],
    },
    discovery: {
      source: "manual-research",
      discoveredAt: DISCOVERED_AT,
      evidence: [
        ...evidence,
        "Public site identifies Shopify as the commerce platform. The standard products.json endpoint is recorded only as a qualification candidate and remains explicitly unapproved until dry-run validation.",
      ],
    },
  };
}

function genericCandidate({ id, name, websiteUrl, tcgs = ["pokemon"], retailerClass = RETAILER_CLASSES.INDEPENDENT, catalogueUrl = null, evidence = [] }) {
  return {
    id,
    name,
    websiteUrl,
    retailerClass,
    adapterType: ADAPTER_TYPES.GENERIC_HTML,
    state: RETAILER_STATES.CANDIDATE,
    verification: VERIFICATION_STATES.UNVERIFIED,
    rrpAuthority: RRP_AUTHORITY.NONE,
    tcgs,
    catalogue: { urls: [catalogueUrl || websiteUrl] },
    discovery: {
      source: "manual-research",
      discoveredAt: DISCOVERED_AT,
      evidence,
    },
  };
}

// Public-source-backed retailer candidates only. Inclusion here is not a
// partnership, endorsement, stock assertion or monitoring approval.
export const ukRetailerExpansion20260821 = [
  shopifyCandidate({
    id: "go-cards-uk",
    name: "Go Cards UK",
    websiteUrl: "https://gocardsuk.co.uk/",
    catalogueUrl: "https://gocardsuk.co.uk/collections/scarlet-violet-all-products",
    evidence: ["Public UK site sells Pokemon TCG sealed products and states UK delivery; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "buy-any-cards",
    name: "BuyAnyCards",
    websiteUrl: "https://buyanycards.co.uk/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    catalogueUrl: "https://buyanycards.co.uk/collections/featured-products",
    tcgs: ["pokemon", "one-piece"],
    evidence: ["Public site describes a UK online and physical TCG shop in Trowbridge selling Pokemon sealed products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "cora-cards",
    name: "Cora Cards",
    websiteUrl: "https://coracards.co.uk/",
    tcgs: ["pokemon", "one-piece"],
    evidence: ["Public UK site advertises authentic sealed Pokemon and One Piece TCG products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "atl-collectibles",
    name: "ATL Collectibles",
    websiteUrl: "https://atlcollectibles.co.uk/",
    evidence: ["Public UK site sells Pokemon sealed products, singles and graded cards; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "crestock",
    name: "CRestock",
    websiteUrl: "https://crestock.co.uk/",
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    evidence: ["Public UK site lists sealed Pokemon products and restock/drop inventory; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "lz-collectibles",
    name: "LZ Collectibles",
    websiteUrl: "https://lzcollectibles.com/",
    tcgs: ["pokemon", "one-piece"],
    evidence: ["Public site identifies a UK trading-card business registered in Bath and sells Pokemon and One Piece products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "card-goblin",
    name: "Card Goblin",
    websiteUrl: "https://www.cardgoblin.shop/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    tcgs: ["pokemon", "one-piece", "magic", "universus"],
    evidence: ["Public UK store sells and trades multiple TCGs including Pokemon and One Piece and publishes physical opening hours; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "the-card-club-uk",
    name: "The Card Club UK",
    websiteUrl: "https://thecardclubuk.shop/",
    tcgs: ["pokemon", "one-piece", "dragon-ball"],
    evidence: ["Public UK TCG store lists Pokemon, One Piece and Dragon Ball products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "phantom-cards-uk",
    name: "Phantom Cards UK",
    websiteUrl: "https://www.phantomcardsuk.com/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    evidence: ["Public site identifies a Nottingham UK TCG and collectibles business selling Pokemon products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "gy-gaming",
    name: "GY Gaming & Collectibles",
    websiteUrl: "https://gygaming.co.uk/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    tcgs: ["pokemon"],
    catalogueUrl: "https://gygaming.co.uk/collections/trading-card-games",
    evidence: ["Public site identifies a family-run specialist collectibles business in Henfield with Pokemon TCG products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "shake-central",
    name: "Shake Central",
    websiteUrl: "https://shakecentral.co.uk/",
    tcgs: ["pokemon", "one-piece"],
    catalogueUrl: "https://shakecentral.co.uk/collections/all",
    evidence: ["Public UK storefront lists sealed Pokemon and One Piece products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "kids-monster",
    name: "Kids Monster",
    websiteUrl: "https://kidsmonster.co.uk/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    evidence: ["Public site identifies two Brighton physical stores and sells Pokemon card products; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "comics-and-beyond",
    name: "Comics & Beyond",
    websiteUrl: "https://www.comicsandbeyond.co.uk/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    tcgs: ["pokemon", "magic", "yugioh"],
    evidence: ["Public Eastbourne store lists Pokemon, Magic and Yu-Gi-Oh! trading cards with pickup availability; site footer states Powered by Shopify."],
  }),
  shopifyCandidate({
    id: "the-mall-lpl",
    name: "The Mall LPL",
    websiteUrl: "https://www.themalllpl.com/",
    retailerClass: RETAILER_CLASSES.REGIONAL,
    tcgs: ["pokemon", "one-piece", "lorcana", "dragon-ball"],
    evidence: ["Public site identifies a Liverpool registered business selling multiple sealed TCG ranges including Pokemon; site footer states Powered by Shopify."],
  }),
  genericCandidate({
    id: "sealcrest",
    name: "Sealcrest",
    websiteUrl: "https://sealcrest.shop/",
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    tcgs: ["pokemon", "one-piece", "digimon", "dragon-ball", "flesh-and-blood"],
    catalogueUrl: "https://sealcrest.shop/shop/other-tcg",
    evidence: ["Public site describes an independent UK sealed-TCG retailer with Pokemon and multiple other TCG catalogues and free tracked UK delivery."],
  }),
  genericCandidate({
    id: "shuffled",
    name: "Shuffled",
    websiteUrl: "https://www.shuffled.gg/",
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    tcgs: ["pokemon", "magic", "lorcana", "star-wars-unlimited", "yugioh", "one-piece", "digimon", "dragon-ball", "weiss-schwarz", "riftbound"],
    catalogueUrl: "https://www.shuffled.gg/collections/pokemon",
    evidence: ["Public site describes a London independent TCG store and exposes a dedicated Pokemon collection."],
  }),
  genericCandidate({
    id: "cardfish",
    name: "CardFish",
    websiteUrl: "https://www.cardfish.uk/",
    evidence: ["Public site describes a small UK Pokemon trading-card store and exposes booster-pack and expansion shopping categories."],
  }),
  genericCandidate({
    id: "koi-cards",
    name: "Koi Cards",
    websiteUrl: "https://www.koicards.co.uk/",
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    evidence: ["Public UK Pokemon trading-card store exposes sealed booster-box inventory and online ordering."],
  }),
];
