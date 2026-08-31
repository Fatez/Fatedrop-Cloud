import { createStore } from "../stores/index.mjs";
import { additionalLaunchRetailers } from "./additional-launch-retailers.mjs";
import { ADAPTER_TYPES, RETAILER_STATES, RRP_AUTHORITY, normalizeRetailerCandidate } from "./registry.mjs";
import { PostgresRetailerRegistry } from "./postgres-registry.mjs";
import { ensureStaticRetailersInRegistry } from "./static-registry-sync.mjs";

function compilePattern(value, field) {
  if (!value) throw new Error(`${field} is required for generic HTML runtime`);
  if (value instanceof RegExp) return value;
  try { return new RegExp(String(value), "i"); } catch { throw new Error(`${field} is not a valid regular expression`); }
}

export function retailerToAdapterConfig(input, { requireMonitored = true, allowUnapprovedFeed = false } = {}) {
  const retailer = normalizeRetailerCandidate(input);
  if (requireMonitored && retailer.state !== RETAILER_STATES.MONITORED) throw new Error(`${retailer.id} is not in monitored state`);
  const activeTcgs = retailer.monitoring.activeTcgs || [];
  if (activeTcgs.length !== 1) throw new Error(`${retailer.id} must have exactly one active TCG in runtime v1`);
  const runtime = retailer.catalogue.runtime;
  const base = {
    id: retailer.id,
    name: retailer.name,
    countryCode: retailer.countryCode,
    tcg: activeTcgs[0],
    baseUrl: retailer.websiteUrl,
    adapterType: retailer.adapterType,
    officialRrpSource: retailer.rrpAuthority === RRP_AUTHORITY.OFFICIAL,
    delivery: retailer.delivery,
    monitoring: retailer.monitoring,
    catalogue: retailer.catalogue,
    include: runtime.include ? compilePattern(runtime.include, "include") : null,
    exclude: runtime.exclude ? compilePattern(runtime.exclude, "exclude") : null,
  };
  if ([ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    if (!retailer.catalogue.feedUrl) throw new Error(`${retailer.id} structured feed URL is required`);
    if (retailer.catalogue.feedApproved !== true && allowUnapprovedFeed !== true) throw new Error(`${retailer.id} structured feed is not approved`);
    return base;
  }
  if (retailer.adapterType === ADAPTER_TYPES.GENERIC_HTML) {
    return {
      ...base,
      catalogueUrls: retailer.catalogue.urls,
      productUrlPattern: compilePattern(runtime.productUrlPattern, "productUrlPattern"),
      skuPattern: compilePattern(runtime.skuPattern, "skuPattern"),
      cardSelector: runtime.cardSelector || undefined,
      titleSelector: runtime.titleSelector || undefined,
      priceSelector: runtime.priceSelector || undefined,
      pageParam: runtime.pageParam || "page",
      maxPages: runtime.maxPages || 20,
      delayMs: runtime.delayMs || 1800,
    };
  }
  throw new Error(`${retailer.id} adapter ${retailer.adapterType} is not enabled for registry runtime`);
}

export function retailerToRuntimeConfig(input) {
  return retailerToAdapterConfig(input, { requireMonitored: true, allowUnapprovedFeed: false });
}

export function selectRuntimeRetailers({ staticRetailers = [], registryRetailers = [] } = {}) {
  const staticById = new Map((staticRetailers || [])
    .filter((retailer) => retailer?.id)
    .map((retailer) => [retailer.id, retailer]));
  return (registryRetailers || [])
    .filter((retailer) => retailer?.state === RETAILER_STATES.MONITORED)
    .map((retailer) => staticById.get(retailer.id) || retailerToRuntimeConfig(retailer));
}

export async function loadRuntimeRetailers({ staticRetailers = [], registryEnabled = false, databaseUrl = "", store = null } = {}) {
  const launchRetailers = [...staticRetailers];
  const byLaunchId = new Map(launchRetailers.map((retailer) => [retailer.id, retailer]));
  for (const retailer of additionalLaunchRetailers()) byLaunchId.set(retailer.id, retailer);
  const launch = [...byLaunchId.values()];

  if (!registryEnabled) return launch;
  if (!databaseUrl) throw new Error("Retailer registry runtime requires DATABASE_URL");
  const canonicalStore = store || createStore();
  if (typeof canonicalStore?.pool !== "function") throw new Error("Retailer registry runtime requires the canonical PostgreSQL store");
  const registry = new PostgresRetailerRegistry(databaseUrl, { poolProvider: () => canonicalStore.pool() });
  await ensureStaticRetailersInRegistry({ registry, staticRetailers: launch });
  const monitored = await registry.list({ states: [RETAILER_STATES.MONITORED], limit: 5000 });
  return selectRuntimeRetailers({ staticRetailers: launch, registryRetailers: monitored });
}
