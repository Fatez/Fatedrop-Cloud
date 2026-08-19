import { normalizeRetailerCandidate } from "./registry.mjs";

function scoreCandidate(candidate) {
  let score = 0;
  if (candidate.websiteUrl) score += 20;
  if (candidate.catalogue.urls.length || candidate.catalogue.feedUrl) score += 25;
  if (candidate.tcgs.length) score += 10;
  if (candidate.delivery.known) score += 10;
  if (candidate.discovery.evidence.length) score += Math.min(20, candidate.discovery.evidence.length * 4);
  if (candidate.physicalLocations > 0) score += 5;
  return Math.min(100, score);
}

export function discoveryKey(input) {
  const candidate = normalizeRetailerCandidate(input);
  return candidate.hostname || candidate.id;
}

export function mergeRetailerCandidates(leftInput, rightInput) {
  const left = normalizeRetailerCandidate(leftInput);
  const right = normalizeRetailerCandidate(rightInput);
  if (discoveryKey(left) !== discoveryKey(right)) throw new Error("Cannot merge different retailer identities");
  const preferred = scoreCandidate(right) > scoreCandidate(left) ? right : left;
  const secondary = preferred === left ? right : left;
  const evidence = [...new Set([...preferred.discovery.evidence, ...secondary.discovery.evidence])];
  const catalogueUrls = [...new Set([...preferred.catalogue.urls, ...secondary.catalogue.urls])];
  return normalizeRetailerCandidate({
    ...secondary,
    ...preferred,
    id: preferred.id || secondary.id,
    name: preferred.name || secondary.name,
    websiteUrl: preferred.websiteUrl || secondary.websiteUrl,
    retailerClass: preferred.retailerClass,
    adapterType: preferred.adapterType,
    state: preferred.state,
    verification: preferred.verification,
    rrpAuthority: preferred.rrpAuthority,
    tcgs: [...new Set([...preferred.tcgs, ...secondary.tcgs])],
    online: preferred.online || secondary.online,
    physicalLocations: Math.max(preferred.physicalLocations, secondary.physicalLocations),
    catalogue: {
      ...secondary.catalogue,
      ...preferred.catalogue,
      urls: catalogueUrls,
      feedUrl: preferred.catalogue.feedUrl || secondary.catalogue.feedUrl,
      platformEvidence: [...new Set([...preferred.catalogue.platformEvidence, ...secondary.catalogue.platformEvidence])],
    },
    delivery: preferred.delivery.known ? preferred.delivery : secondary.delivery,
    monitoring: preferred.monitoring,
    discovery: {
      source: preferred.discovery.source || secondary.discovery.source,
      discoveredAt: [preferred.discovery.discoveredAt, secondary.discovery.discoveredAt].filter(Boolean).sort()[0] || new Date(0).toISOString(),
      evidence,
    },
  });
}

export function deduplicateRetailerCandidates(inputs = []) {
  const byKey = new Map();
  for (const input of inputs) {
    const candidate = normalizeRetailerCandidate(input);
    const key = discoveryKey(candidate);
    if (!key) continue;
    byKey.set(key, byKey.has(key) ? mergeRetailerCandidates(byKey.get(key), candidate) : candidate);
  }
  return [...byKey.values()].map((candidate) => ({ ...candidate, discoveryScore: scoreCandidate(candidate) }))
    .sort((a, b) => b.discoveryScore - a.discoveryScore || a.name.localeCompare(b.name));
}

export function candidateCoverage(candidates = []) {
  const rows = deduplicateRetailerCandidates(candidates);
  return {
    total: rows.length,
    byClass: Object.fromEntries([...new Set(rows.map((row) => row.retailerClass))].map((value) => [value, rows.filter((row) => row.retailerClass === value).length])),
    byAdapter: Object.fromEntries([...new Set(rows.map((row) => row.adapterType))].map((value) => [value, rows.filter((row) => row.adapterType === value).length])),
    withCatalogueEntrypoint: rows.filter((row) => row.catalogue.urls.length || row.catalogue.feedUrl).length,
    withKnownDelivery: rows.filter((row) => row.delivery.known).length,
    verified: rows.filter((row) => row.verification === "verified").length,
  };
}
