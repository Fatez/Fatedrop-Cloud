import { env } from "../config/env.mjs";
import { ADAPTER_TYPES, RETAILER_CLASSES, RRP_AUTHORITY, VERIFICATION_STATES } from "./registry.mjs";

const SEALED_PRODUCT = /booster|elite trainer|\betb\b|collection|tin\b|blister|deck\b|battle academy|trainer toolkit|build\s*&\s*battle|premium|bundle|display|box\b|pack\b|poster|tech sticker|mini portfolio|first partner|ultra premium/i;
const NON_PRODUCT = /\bsingle\b|code card|sleeve|binder only|playmat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b/i;

function tgcCollectables(enabled) {
  return {
    id: "tgc-collectables",
    name: "TGC Collectables",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.RETAILER_REFERENCE,
    enabled,
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

function travellingManUk(enabled) {
  return {
    id: "travelling-man-uk",
    name: "Travelling Man UK",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.RETAILER_REFERENCE,
    enabled,
    baseUrl: "https://travellingman.com/",
    catalogue: {
      feedUrl: "https://travellingman.com/collections/pokemon-tcg/products.json?limit=250",
      feedApproved: true,
      runtime: { maxPages: 4, delayMs: 900 },
    },
    officialRrpSource: false,
    include: SEALED_PRODUCT,
    exclude: /\bsingle\b|code card|sleeve|binder|play\s?mat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b|portfolio|deck box/i,
  };
}

function theTcgShopUk(enabled) {
  return {
    id: "the-tcg-shop-uk",
    name: "The TCG Shop",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.RETAILER_REFERENCE,
    enabled,
    baseUrl: "https://www.thetcgshop.co.uk/",
    catalogue: {
      feedUrl: "https://www.thetcgshop.co.uk/collections/pokemon/products.json?limit=250",
      feedApproved: true,
      runtime: { maxPages: 2, delayMs: 900 },
    },
    officialRrpSource: false,
    include: SEALED_PRODUCT,
    exclude: NON_PRODUCT,
  };
}

function amazonUk({ enabled, marketplace }) {
  return {
    id: "amazon-uk",
    name: "Amazon UK Marketplace",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.NATIONAL,
    adapterType: ADAPTER_TYPES.STRUCTURED_FEED,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.NONE,
    enabled,
    baseUrl: "https://www.amazon.co.uk/",
    catalogue: {
      provider: "amazon_creators_api",
      marketplace,
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

export function amazonUkIntegrationReadiness({
  requested = env.retailers.amazonUk,
  credentialsConfigured = env.amazonCreators.configured,
  storagePolicyCompatible = false,
} = {}) {
  const ready = Boolean(requested && credentialsConfigured && storagePolicyCompatible);
  let reason = null;
  if (!requested) reason = "disabled_by_feature_flag";
  else if (!credentialsConfigured) reason = "creators_api_credentials_required";
  else if (!storagePolicyCompatible) reason = "amazon_content_retention_guard";
  return { requested: Boolean(requested), credentialsConfigured: Boolean(credentialsConfigured), storagePolicyCompatible: Boolean(storagePolicyCompatible), ready, reason };
}

export function buildAdditionalLaunchRetailers({
  tgcEnabled = env.retailers.tgcCollectables,
  amazonRequested = env.retailers.amazonUk,
  amazonCredentialsConfigured = env.amazonCreators.configured,
  amazonStoragePolicyCompatible = false,
  amazonMarketplace = env.amazonCreators.marketplace,
} = {}) {
  const amazon = amazonUkIntegrationReadiness({
    requested: amazonRequested,
    credentialsConfigured: amazonCredentialsConfigured,
    storagePolicyCompatible: amazonStoragePolicyCompatible,
  });
  return [
    tgcCollectables(Boolean(tgcEnabled)),
    amazonUk({ enabled: amazon.ready, marketplace: amazonMarketplace }),
  ].filter((retailer) => retailer.enabled);
}

export function additionalLaunchRetailers() {
  return [
    ...buildAdditionalLaunchRetailers(),
    travellingManUk(Boolean(env.retailers.travellingManUk)),
    theTcgShopUk(Boolean(env.retailers.theTcgShopUk)),
  ].filter((retailer) => retailer.enabled);
}
