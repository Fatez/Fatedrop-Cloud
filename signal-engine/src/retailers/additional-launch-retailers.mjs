import { env } from "../config/env.mjs";
import { ADAPTER_TYPES, RETAILER_CLASSES, RRP_AUTHORITY, VERIFICATION_STATES } from "./registry.mjs";

const SEALED_PRODUCT = /booster|elite trainer|\betb\b|collection|tin\b|blister|deck\b|battle academy|trainer toolkit|build\s*&\s*battle|premium|bundle|display|box\b|pack\b|poster|tech sticker|mini portfolio|first partner|ultra premium/i;
const NON_PRODUCT = /\bsingle\b|code card|sleeve|binder only|playmat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b/i;

function tgcCollectables() {
  return {
    id: "tgc-collectables",
    name: "TGC Collectables",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.RETAILER_REFERENCE,
    enabled: env.retailers.tgcCollectables,
    baseUrl: "https://collect.thegamecollection.net/",
    catalogue: {
      feedUrl: "https://collect.thegamecollection.net/collections/pokemon/products.json?limit=250",
      feedApproved: true,
      runtime: { maxPages: 4, delayMs: 1200 },
    },
    officialRrpSource: false,
    include: SEALED_PRODUCT,
    exclude: NON_PRODUCT,
  };
}

function amazonUk() {
  return {
    id: "amazon-uk",
    name: "Amazon UK Marketplace",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.NATIONAL,
    adapterType: ADAPTER_TYPES.STRUCTURED_FEED,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.NONE,
    enabled: env.retailers.amazonUk && env.amazonCreators.configured,
    baseUrl: "https://www.amazon.co.uk/",
    catalogue: {
      provider: "amazon_creators_api",
      marketplace: env.amazonCreators.marketplace,
      searchTerms: [
        "Pokemon TCG Elite Trainer Box",
        "Pokemon TCG Booster Bundle",
        "Pokemon TCG Booster Box",
        "Pokemon TCG Booster Pack",
        "Pokemon TCG Collection Box",
        "Pokemon TCG Tin",
        "Pokemon TCG Blister",
      ],
      runtime: { maxPages: 1, delayMs: 1200 },
    },
    officialRrpSource: false,
    include: SEALED_PRODUCT,
    exclude: NON_PRODUCT,
  };
}

export function additionalLaunchRetailers() {
  return [tgcCollectables(), amazonUk()].filter((retailer) => retailer.enabled);
}
