import { ADAPTER_TYPES, RETAILER_CLASSES, RRP_AUTHORITY, VERIFICATION_STATES } from "./registry.mjs";

const SEALED_PRODUCT = /booster|elite trainer|\betb\b|collection|tin\b|blister|deck\b|battle academy|trainer toolkit|build\s*&\s*battle|premium|bundle|display|box\b|pack\b|poster|tech sticker|mini portfolio|first partner|ultra premium/i;
const NON_PRODUCT = /\bsingle\b|code card|\bsleeves?\b|\bbinder\b|play\s?mat|top\s?loader|graded|\bpsa\b|\bcgc\b|\bbgs\b|accessor|event ticket|league challenge|tournament|portfolio/i;

export const RETAILER_WAVE_1_IDS = Object.freeze([
  "tritex-games",
  "the-card-vault",
  "shiny-vault",
  "trainers-haven",
  "cob-and-pip",
]);

function structuredRetailer({
  id,
  name,
  retailerClass = RETAILER_CLASSES.INDEPENDENT,
  adapterType,
  baseUrl,
  feedUrl,
  maxPages,
  delayMs = 900,
  expectedMinimumProducts,
}) {
  return {
    id,
    name,
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass,
    adapterType,
    verification: VERIFICATION_STATES.PENDING,
    // Wave 1 is stock intelligence only. Indie prices must not become canonical RRP authority.
    rrpAuthority: RRP_AUTHORITY.NONE,
    enabled: true,
    baseUrl,
    catalogue: {
      feedUrl,
      feedApproved: true,
      runtime: { maxPages, delayMs },
    },
    monitoring: {
      cadenceSeconds: 300,
      expectedMinimumProducts,
      activeTcgs: ["pokemon"],
    },
    officialRrpSource: false,
    include: SEALED_PRODUCT,
    exclude: NON_PRODUCT,
  };
}

export function retailerWave1LaunchRetailers() {
  return [
    structuredRetailer({
      id: "tritex-games",
      name: "Tritex Games",
      retailerClass: RETAILER_CLASSES.SPECIALIST,
      adapterType: ADAPTER_TYPES.WOOCOMMERCE,
      baseUrl: "https://www.tritex-games.co.uk/",
      feedUrl: "https://www.tritex-games.co.uk/wp-json/wc/store/v1/products?per_page=100&search=Pokemon",
      maxPages: 4,
      delayMs: 1200,
      expectedMinimumProducts: 50,
    }),
    structuredRetailer({
      id: "the-card-vault",
      name: "The Card Vault",
      retailerClass: RETAILER_CLASSES.SPECIALIST,
      adapterType: ADAPTER_TYPES.SHOPIFY,
      baseUrl: "https://thecardvault.co.uk/",
      feedUrl: "https://thecardvault.co.uk/collections/pokemon-tcg-sealed-products/products.json?limit=250",
      maxPages: 4,
      expectedMinimumProducts: 100,
    }),
    structuredRetailer({
      id: "shiny-vault",
      name: "Shiny Vault",
      retailerClass: RETAILER_CLASSES.SPECIALIST,
      adapterType: ADAPTER_TYPES.SHOPIFY,
      baseUrl: "https://shinyvault.co.uk/",
      // The custom storefront is backed by this public Shopify catalogue. FateDrop
      // filters it to sealed products; singles never enter lifecycle processing.
      feedUrl: "https://shinyvault-theme-1w7qn.myshopify.com/products.json?limit=250",
      maxPages: 2,
      expectedMinimumProducts: 10,
    }),
    structuredRetailer({
      id: "trainers-haven",
      name: "Trainer's Haven",
      retailerClass: RETAILER_CLASSES.INDEPENDENT,
      adapterType: ADAPTER_TYPES.WOOCOMMERCE,
      baseUrl: "https://trainershaven.co.uk/",
      feedUrl: "https://trainershaven.co.uk/wp-json/wc/store/v1/products?per_page=100&search=Pokemon",
      maxPages: 4,
      delayMs: 1200,
      expectedMinimumProducts: 50,
    }),
    structuredRetailer({
      id: "cob-and-pip",
      name: "Cob & Pip",
      retailerClass: RETAILER_CLASSES.INDEPENDENT,
      adapterType: ADAPTER_TYPES.SHOPIFY,
      baseUrl: "https://cobandpip.co.uk/",
      feedUrl: "https://cobandpip.co.uk/collections/pokemon-tcg-sealed-products/products.json?limit=250",
      maxPages: 2,
      expectedMinimumProducts: 10,
    }),
  ];
}

export const __test = { SEALED_PRODUCT, NON_PRODUCT };
