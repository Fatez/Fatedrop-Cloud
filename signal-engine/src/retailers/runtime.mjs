import { ADAPTER_TYPES, RETAILER_STATES, RRP_AUTHORITY, normalizeRetailerCandidate } from "./registry.mjs";
import { PostgresRetailerRegistry } from "./postgres-registry.mjs";

function compilePattern(value, field) {
  if (!value) throw new Error(`${field} is required for generic HTML runtime`);
  if (value instanceof RegExp) return value;
  try { return new RegExp(String(value), "i"); } catch { throw new Error(`${field} is not a valid regular expression`); }
}

export function retailerToAdapterConfig(input, { requireMonitored = true } = {}) {
  const retailer = normalizeRetailerCandidate(input);
  if (requireMonitored && retailer.state !== RETAILER_STATES.MONITORED) throw new Error(`${retailer.id} is not in monitored state`);
  if (retailer.countryCode !== "GB" && retailer.delivery.shipsToUk !== true) {
    throw new Error(`${retailer.id} cannot enter runtime until UK shipping is confirmed`);
  }
  if (retailer.delivery.currency && retailer.delivery.currency !== "GBP") {
    throw new Error(`${retailer.id} cannot enter runtime until non-GBP FX and landed-cost conversion is enabled`);
  }
  const activeTcgs = retailer.monitoring.activeTcgs || [];
  if (activeTcgs.length !== 1) throw new Error(`${retailer.id} must have exactly one active TCG in runtime v1`);
  const base = {
    id: retailer.id,
    name: retailer.name,
    tcg: activeTcgs[0],
    baseUrl: retailer.websiteUrl,
    adapterType: retailer.adapterType,
    officialRrpSource: retailer.rrpAuthority === RRP_AUTHORITY.OFFICIAL,
    delivery: retailer.delivery,
    monitoring: retailer.monitoring,
    catalogue: retailer.catalogue,
    include: null,
    exclude: null,
  };
  if ([ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    if (!retailer.catalogue.feedUrl || retailer.catalogue.feedApproved !== true) throw new Error(`${retailer.id} structured feed is not approved`);
    return base;
  }
  if (retailer.adapterType === ADAPTER_TYPES.GENERIC_HTML) {
    const runtime = retailer.catalogue.runtime;
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
      include: runtime.include ? compilePattern(runtime.include, "include") : null,
      exclude: runtime.exclude ? compilePattern(runtime.exclude, "exclude") : null,
    };
  }
  throw new Error(`${retailer.id} adapter ${retailer.adapterType} is not enabled for registry runtime`);
}

export function retailerToRuntimeConfig(input) {
  return retailerToAdapterConfig(input, { requireMonitored: true });
}

export async function loadRuntimeRetailers({ staticRetailers = [], registryEnabled = false, databaseUrl = "" } = {}) {
  if (!registryEnabled) return staticRetailers;
  if (!databaseUrl) throw new Error("Retailer registry runtime requires DATABASE_URL");
  const registry = new PostgresRetailerRegistry(databaseUrl);
  const monitored = await registry.list({ states: [RETAILER_STATES.MONITORED], limit: 5000 });
  const dynamic = monitored.map(retailerToRuntimeConfig);
  const byId = new Map(staticRetailers.map((retailer) => [retailer.id, retailer]));
  for (const retailer of dynamic) byId.set(retailer.id, retailer);
  return [...byId.values()];
}
