import { deduplicateRetailerCandidates } from "./discovery.mjs";
import { DISCOVERY_SOURCE_TYPES, discoverySourceEvidence, discoverySourcePolicy } from "./discovery-sources.mjs";
import { ADAPTER_TYPES, RETAILER_CLASSES, normalizeRetailerCandidate } from "./registry.mjs";

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function inferClass(record = {}) {
  if (Object.values(RETAILER_CLASSES).includes(record.retailerClass)) return record.retailerClass;
  const locations = Number(record.physicalLocations || 0);
  if (locations >= 20) return RETAILER_CLASSES.NATIONAL;
  if (locations >= 2) return RETAILER_CLASSES.REGIONAL;
  if (record.onlineOnly === true) return RETAILER_CLASSES.SPECIALIST;
  return RETAILER_CLASSES.INDEPENDENT;
}

export function candidateFromDiscoveryRecord(record = {}, source = {}) {
  const websiteUrl = validHttpUrl(record.websiteUrl || record.url);
  if (!websiteUrl) throw new Error("Discovery record requires a valid retailer website URL");
  const sourceType = Object.values(DISCOVERY_SOURCE_TYPES).includes(source.type)
    ? source.type
    : DISCOVERY_SOURCE_TYPES.MANUAL_RESEARCH;
  const policy = discoverySourcePolicy[sourceType];
  const evidence = discoverySourceEvidence({
    type: sourceType,
    sourceName: source.name || "Unknown discovery source",
    sourceUrl: validHttpUrl(source.url),
    observedAt: source.observedAt,
    note: source.note || record.discoveryNote || null,
  });
  const mayAssertCatalogue = policy?.mayAssertCatalogue === true;
  const catalogueUrl = mayAssertCatalogue ? validHttpUrl(record.catalogueUrl) : null;
  const feedUrl = mayAssertCatalogue ? validHttpUrl(record.feedUrl) : null;
  const platformEvidence = mayAssertCatalogue && Array.isArray(record.platformEvidence) ? record.platformEvidence : [];
  const adapterType = mayAssertCatalogue && Object.values(ADAPTER_TYPES).includes(record.adapterType)
    ? record.adapterType
    : ADAPTER_TYPES.GENERIC_HTML;
  const tcgs = Array.isArray(record.tcgs) && record.tcgs.length ? record.tcgs : ["pokemon"];
  return normalizeRetailerCandidate({
    id: record.id,
    name: record.name,
    websiteUrl,
    countryCode: record.countryCode,
    retailerClass: inferClass(record),
    adapterType,
    tcgs,
    online: record.online !== false,
    physicalLocations: Number.isFinite(record.physicalLocations) ? record.physicalLocations : 0,
    catalogue: {
      urls: catalogueUrl ? [catalogueUrl] : [],
      feedUrl,
      feedApproved: false,
      platformEvidence,
    },
    delivery: {
      known: record.delivery?.known === true,
      standardPence: record.delivery?.standardPence,
      freeAbovePence: record.delivery?.freeAbovePence,
      sourceUrl: validHttpUrl(record.delivery?.sourceUrl),
      observedAt: record.delivery?.observedAt || null,
      shipsToUk: record.delivery?.shipsToUk,
      currency: record.delivery?.currency,
      dutiesIncluded: record.delivery?.dutiesIncluded,
      importFeesKnown: record.delivery?.importFeesKnown,
      importFeesPence: record.delivery?.importFeesPence,
    },
    discovery: {
      source: sourceType,
      discoveredAt: evidence.observedAt,
      evidence: [JSON.stringify(evidence)],
    },
  });
}

export function ingestDiscoveryBatch(records = [], source = {}) {
  if (!Array.isArray(records)) throw new Error("Discovery batch must be an array");
  const accepted = [];
  const rejected = [];
  for (const [index, record] of records.entries()) {
    try {
      accepted.push(candidateFromDiscoveryRecord(record, source));
    } catch (error) {
      rejected.push({ index, name: record?.name || null, reason: String(error?.message || error) });
    }
  }
  const candidates = deduplicateRetailerCandidates(accepted);
  return { candidates, rejected, received: records.length, accepted: accepted.length, unique: candidates.length };
}
