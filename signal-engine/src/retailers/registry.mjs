export const RETAILER_CLASSES = Object.freeze({
  NATIONAL: "national",
  SPECIALIST: "specialist",
  REGIONAL: "regional",
  INDEPENDENT: "independent",
  EVENT_VENDOR: "event_vendor",
});

export const ADAPTER_TYPES = Object.freeze({
  STRUCTURED_FEED: "structured_feed",
  SHOPIFY: "shopify",
  WOOCOMMERCE: "woocommerce",
  GENERIC_HTML: "generic_html",
  BROWSER_COLLECTOR: "browser_collector",
  CSV: "csv",
  MANUAL: "manual",
});

export const RETAILER_STATES = Object.freeze({
  CANDIDATE: "candidate",
  QUALIFYING: "qualifying",
  READY: "ready",
  MONITORED: "monitored",
  PAUSED: "paused",
  REJECTED: "rejected",
});

export const VERIFICATION_STATES = Object.freeze({
  UNVERIFIED: "unverified",
  PENDING: "pending",
  VERIFIED: "verified",
  SUSPENDED: "suspended",
});

export const RRP_AUTHORITY = Object.freeze({
  OFFICIAL: "official",
  RETAILER_REFERENCE: "retailer_reference",
  NONE: "none",
});

function finiteNonNegative(value, fallback = null) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
}

export function normalizeRetailerCandidate(input = {}) {
  const websiteUrl = typeof input.websiteUrl === "string" ? input.websiteUrl.trim() : "";
  let hostname = "";
  try { hostname = websiteUrl ? new URL(websiteUrl).hostname.replace(/^www\./, "") : ""; } catch {}
  const id = String(input.id || hostname || input.name || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const runtime = input.catalogue?.runtime || {};
  return {
    id,
    name: String(input.name || hostname || id || "Unknown retailer").trim(),
    websiteUrl,
    hostname,
    countryCode: "GB",
    retailerClass: Object.values(RETAILER_CLASSES).includes(input.retailerClass) ? input.retailerClass : RETAILER_CLASSES.INDEPENDENT,
    adapterType: Object.values(ADAPTER_TYPES).includes(input.adapterType) ? input.adapterType : ADAPTER_TYPES.GENERIC_HTML,
    state: Object.values(RETAILER_STATES).includes(input.state) ? input.state : RETAILER_STATES.CANDIDATE,
    verification: Object.values(VERIFICATION_STATES).includes(input.verification) ? input.verification : VERIFICATION_STATES.UNVERIFIED,
    rrpAuthority: Object.values(RRP_AUTHORITY).includes(input.rrpAuthority) ? input.rrpAuthority : RRP_AUTHORITY.NONE,
    tcgs: Array.isArray(input.tcgs) ? [...new Set(input.tcgs.map((value) => String(value).toLowerCase().trim()).filter(Boolean))] : ["pokemon"],
    online: input.online !== false,
    physicalLocations: finiteNonNegative(input.physicalLocations, 0),
    catalogue: {
      urls: Array.isArray(input.catalogue?.urls) ? [...new Set(input.catalogue.urls.filter(Boolean))] : [],
      feedUrl: input.catalogue?.feedUrl || null,
      feedApproved: input.catalogue?.feedApproved === true,
      platformEvidence: stringArray(input.catalogue?.platformEvidence),
      runtime: {
        productUrlPattern: runtime.productUrlPattern || null,
        skuPattern: runtime.skuPattern || null,
        cardSelector: runtime.cardSelector || null,
        titleSelector: runtime.titleSelector || null,
        priceSelector: runtime.priceSelector || null,
        pageParam: runtime.pageParam || "page",
        maxPages: Number.isFinite(runtime.maxPages) ? Math.max(1, Math.min(500, runtime.maxPages)) : 20,
        delayMs: Number.isFinite(runtime.delayMs) ? Math.max(250, runtime.delayMs) : 1800,
        include: runtime.include || null,
        exclude: runtime.exclude || null,
      },
    },
    delivery: {
      known: input.delivery?.known === true,
      standardPence: finiteNonNegative(input.delivery?.standardPence),
      freeAbovePence: finiteNonNegative(input.delivery?.freeAbovePence),
      sourceUrl: input.delivery?.sourceUrl || null,
      observedAt: input.delivery?.observedAt || null,
    },
    monitoring: {
      cadenceSeconds: Number.isFinite(input.monitoring?.cadenceSeconds) ? Math.max(60, input.monitoring.cadenceSeconds) : 300,
      expectedMinimumProducts: Number.isFinite(input.monitoring?.expectedMinimumProducts) ? Math.max(0, input.monitoring.expectedMinimumProducts) : null,
      activeTcgs: Array.isArray(input.monitoring?.activeTcgs) && input.monitoring.activeTcgs.length
        ? [...new Set(input.monitoring.activeTcgs.map((value) => String(value).toLowerCase().trim()).filter(Boolean))]
        : ["pokemon"],
      allowIncompleteReplacement: false,
    },
    discovery: {
      source: input.discovery?.source || "manual",
      discoveredAt: input.discovery?.discoveredAt || new Date(0).toISOString(),
      evidence: Array.isArray(input.discovery?.evidence) ? input.discovery.evidence : [],
    },
  };
}

export function qualifyRetailer(candidate) {
  const retailer = normalizeRetailerCandidate(candidate);
  const reasons = [];
  if (!retailer.websiteUrl || !retailer.hostname) reasons.push("missing-valid-website");
  if (!retailer.tcgs.length) reasons.push("no-supported-tcg-evidence");
  if (![ADAPTER_TYPES.CSV, ADAPTER_TYPES.MANUAL].includes(retailer.adapterType) && !retailer.catalogue.urls.length && !retailer.catalogue.feedUrl) reasons.push("no-catalogue-entrypoint");
  return {
    retailer,
    eligible: reasons.length === 0,
    reasons,
    nextState: reasons.length ? RETAILER_STATES.CANDIDATE : RETAILER_STATES.QUALIFYING,
  };
}

export function publicRetailerProfile(candidate) {
  const retailer = normalizeRetailerCandidate(candidate);
  return {
    id: retailer.id,
    name: retailer.name,
    websiteUrl: retailer.websiteUrl,
    retailerClass: retailer.retailerClass,
    verification: retailer.verification,
    tcgs: retailer.tcgs,
    online: retailer.online,
    physicalLocations: retailer.physicalLocations,
    deliveryKnown: retailer.delivery.known,
  };
}
