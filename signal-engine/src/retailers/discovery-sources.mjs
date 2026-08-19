export const DISCOVERY_SOURCE_TYPES = Object.freeze({
  PUBLIC_DIRECTORY: "public_directory",
  PUBLIC_SEARCH: "public_search",
  EVENT_DIRECTORY: "event_directory",
  RETAILER_SUBMISSION: "retailer_submission",
  MANUAL_RESEARCH: "manual_research",
});

// Discovery sources may identify candidate businesses only. They never become
// stock, price, delivery, verification or partnership evidence by themselves.
export const discoverySourcePolicy = Object.freeze({
  [DISCOVERY_SOURCE_TYPES.PUBLIC_DIRECTORY]: {
    mayDiscoverRetailer: true,
    mayAssertCatalogue: false,
    mayAssertPrice: false,
    mayAssertStock: false,
    mayAssertVerification: false,
  },
  [DISCOVERY_SOURCE_TYPES.PUBLIC_SEARCH]: {
    mayDiscoverRetailer: true,
    mayAssertCatalogue: false,
    mayAssertPrice: false,
    mayAssertStock: false,
    mayAssertVerification: false,
  },
  [DISCOVERY_SOURCE_TYPES.EVENT_DIRECTORY]: {
    mayDiscoverRetailer: true,
    mayAssertCatalogue: false,
    mayAssertPrice: false,
    mayAssertStock: false,
    mayAssertVerification: false,
  },
  [DISCOVERY_SOURCE_TYPES.RETAILER_SUBMISSION]: {
    mayDiscoverRetailer: true,
    mayAssertCatalogue: true,
    mayAssertPrice: false,
    mayAssertStock: false,
    mayAssertVerification: false,
  },
  [DISCOVERY_SOURCE_TYPES.MANUAL_RESEARCH]: {
    mayDiscoverRetailer: true,
    mayAssertCatalogue: true,
    mayAssertPrice: false,
    mayAssertStock: false,
    mayAssertVerification: false,
  },
});

export function discoverySourceEvidence({ type, sourceName, sourceUrl = null, observedAt = null, note = null } = {}) {
  if (!Object.values(DISCOVERY_SOURCE_TYPES).includes(type)) throw new Error("Unsupported discovery source type");
  if (!String(sourceName || "").trim()) throw new Error("Discovery evidence requires sourceName");
  return {
    type,
    sourceName: String(sourceName).trim(),
    sourceUrl: sourceUrl || null,
    observedAt: observedAt || new Date().toISOString(),
    note: note || null,
    scope: "candidate-discovery-only",
  };
}
