import { RETAILER_STATES } from "./registry.mjs";

function patternSource(value) {
  if (!value) return null;
  if (value instanceof RegExp) return value.source;
  return String(value);
}

export function staticRetailerToRegistryCandidate(retailer = {}) {
  const catalogueRuntime = retailer.catalogue?.runtime || {};
  const tcgs = Array.isArray(retailer.tcgs) && retailer.tcgs.length
    ? retailer.tcgs
    : retailer.tcg
      ? [retailer.tcg]
      : ["pokemon"];
  return {
    id: retailer.id,
    name: retailer.name,
    websiteUrl: retailer.baseUrl,
    retailerClass: retailer.retailerClass,
    adapterType: retailer.adapterType,
    state: retailer.enabled === false ? RETAILER_STATES.PAUSED : RETAILER_STATES.MONITORED,
    verification: retailer.verification,
    rrpAuthority: retailer.rrpAuthority,
    tcgs,
    online: true,
    physicalLocations: 0,
    catalogue: {
      urls: Array.isArray(retailer.catalogueUrls) ? retailer.catalogueUrls : [],
      feedUrl: retailer.catalogue?.feedUrl || null,
      feedApproved: retailer.catalogue?.feedApproved === true,
      platformEvidence: [],
      runtime: {
        productUrlPattern: patternSource(retailer.productUrlPattern || catalogueRuntime.productUrlPattern),
        skuPattern: patternSource(retailer.skuPattern || catalogueRuntime.skuPattern),
        cardSelector: retailer.cardSelector || catalogueRuntime.cardSelector || null,
        titleSelector: retailer.titleSelector || catalogueRuntime.titleSelector || null,
        priceSelector: retailer.priceSelector || catalogueRuntime.priceSelector || null,
        pageParam: retailer.pageParam || catalogueRuntime.pageParam || "page",
        maxPages: retailer.maxPages || catalogueRuntime.maxPages || 20,
        delayMs: retailer.delayMs || catalogueRuntime.delayMs || 1800,
        include: patternSource(retailer.include || catalogueRuntime.include),
        exclude: patternSource(retailer.exclude || catalogueRuntime.exclude),
      },
    },
    delivery: retailer.delivery || {},
    monitoring: {
      cadenceSeconds: retailer.monitoring?.cadenceSeconds || 300,
      expectedMinimumProducts: retailer.monitoring?.expectedMinimumProducts ?? null,
      activeTcgs: retailer.monitoring?.activeTcgs || tcgs,
    },
    discovery: {
      source: "static_launch_config",
      discoveredAt: new Date(0).toISOString(),
      evidence: [{ type: "configured_retailer", source: "signal-engine/src/config/retailers.mjs" }],
    },
  };
}

export async function ensureStaticRetailersInRegistry({ registry, staticRetailers = [] } = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.upsert !== "function") {
    throw new TypeError("Canonical retailer registry is required");
  }
  const existing = await registry.list({ limit: 5000 });
  const knownIds = new Set((existing || []).map((retailer) => String(retailer?.id || "")).filter(Boolean));
  const inserted = [];
  for (const retailer of staticRetailers || []) {
    if (!retailer?.id || knownIds.has(retailer.id)) continue;
    const saved = await registry.upsert(staticRetailerToRegistryCandidate(retailer));
    knownIds.add(retailer.id);
    inserted.push(saved.id);
  }
  return { inserted, insertedCount: inserted.length, existingCount: knownIds.size - inserted.length };
}
