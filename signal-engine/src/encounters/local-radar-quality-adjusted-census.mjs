import { reconcileLocationQuality } from "./canonical-retailer-locations.mjs";
import {
  isEchoEligibleLocation,
  locationServiceKind,
  normalizeLocationPolicy,
} from "./local-radar-location-policy.mjs";

const TRUSTED_BRANCH_VERIFICATIONS = new Set([
  "official_retailer_branch",
  "curated_branch",
]);

const TRUSTED_BRANCH_SOURCE_TYPES = new Set([
  "official_retailer_branch_page",
  "official_branch_page",
  "official_retailer_directory",
  "curated_branch_seed",
]);

const DISCOVERY_PROVIDER_RE = /(?:google(?:_places)?|openstreetmap|\bosm\b|places_discovery|provider_discovered)/i;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function lower(value) {
  return text(value)?.toLowerCase() || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function slug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distanceMiles(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizeAuditRow(row = {}) {
  const openingDetails = row.openingDetails ?? row.opening_details_json ?? {};
  const locationEvidence = row.locationEvidence ?? row.location_evidence ?? {};
  return {
    id: text(row.id),
    retailerId: text(row.retailerId ?? row.retailer_id),
    provider: lower(row.provider) || "unknown",
    providerId: text(row.providerId ?? row.provider_id ?? row.providerPlaceId),
    name: text(row.name) || "Unknown branch",
    address: text(row.address),
    postcode: text(row.postcode)?.toUpperCase() || null,
    latitude: number(row.latitude),
    longitude: number(row.longitude),
    website: text(row.website ?? row.websiteUrl),
    phone: text(row.phone),
    openingDetails,
    verification: lower(row.verification ?? row.verificationStatus) || "source_verified",
    updatedAt: number(row.updatedAt ?? row.updated_at ?? row.branchUpdatedAt),
    retailerCategory: lower(row.retailerCategory ?? row.retailer_category),
    storeFormat: lower(row.storeFormat ?? row.store_format),
    operationalStatus: lower(row.operationalStatus ?? row.operational_status),
    tcgSellerStatus: lower(row.tcgSellerStatus ?? row.tcg_seller_status ?? locationEvidence.pokemonSeller),
    tcgSellerConfidence: number(row.tcgSellerConfidence ?? row.tcg_seller_confidence ?? locationEvidence.confidence),
    identityStatus: lower(row.identityStatus ?? row.identity_status ?? locationEvidence.branchIdentity),
    lastVerifiedAt: number(row.lastVerifiedAt ?? row.last_verified_at ?? locationEvidence.lastVerifiedAt),
    evidenceSourceCount: Math.max(0, Number(row.evidenceSourceCount ?? row.evidence_source_count ?? locationEvidence.sourceCount) || 0),
    sourceType: lower(row.sourceType ?? row.source_type ?? openingDetails?.sourceType),
    sourceUrl: text(row.sourceUrl ?? row.source_url ?? openingDetails?.sourceUrl),
  };
}

function legacyPublicEligible(location = {}) {
  const policy = normalizeLocationPolicy(location);
  return policy.operationalStatus !== "closed"
    && policy.identityStatus !== "conflicted"
    && !["excluded", "conflicted"].includes(policy.tcgSellerStatus);
}

function officialProvider(provider) {
  const value = lower(provider) || "";
  return value === "fatedrop_curated_branch"
    || /(?:^|_)official(?:_|$)/.test(value)
    || value.includes("official_directory")
    || value.includes("official_stockist");
}

function discoveryProvider(location = {}) {
  return location.verification === "provider_discovered"
    || DISCOVERY_PROVIDER_RE.test(location.provider || "");
}

export function hasTrustedCanonicalParentEvidence(row = {}) {
  const location = normalizeAuditRow(row);
  if (!location.id || !location.retailerId) return false;
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return false;
  if (locationServiceKind(location)) return false;

  const policy = normalizeLocationPolicy(location);
  if (policy.operationalStatus === "closed") return false;
  if (["conflicted", "provisional"].includes(location.identityStatus)) return false;
  if (["excluded", "conflicted"].includes(policy.tcgSellerStatus)) return false;

  const trustedVerification = TRUSTED_BRANCH_VERIFICATIONS.has(location.verification);
  const trustedSourceType = TRUSTED_BRANCH_SOURCE_TYPES.has(location.sourceType);
  const trustedProvider = officialProvider(location.provider);
  const acceptedCanonicalEvidence = location.identityStatus === "canonical"
    && location.evidenceSourceCount > 0
    && !discoveryProvider(location);

  return trustedVerification || trustedSourceType || trustedProvider || acceptedCanonicalEvidence;
}

function sameCanonicalParent(a, b) {
  if (!a?.retailerId || a.retailerId !== b?.retailerId) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.provider === b.provider && a.providerId && b.providerId && String(a.providerId) === String(b.providerId)) return true;

  const leftPostcode = postcodeKey(a.postcode);
  const rightPostcode = postcodeKey(b.postcode);
  const sameName = Boolean(slug(a.name) && slug(a.name) === slug(b.name));
  const proximity = distanceMiles(a, b);

  if (leftPostcode && rightPostcode && leftPostcode === rightPostcode && sameName) return true;
  return proximity != null && proximity <= 0.03 && sameName;
}

function disjointSet(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  function find(index) {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  }
  function union(left, right) {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  }
  return { find, union };
}

function trustScore(location) {
  let score = 0;
  if (TRUSTED_BRANCH_VERIFICATIONS.has(location.verification)) score += 40;
  if (officialProvider(location.provider)) score += 30;
  if (TRUSTED_BRANCH_SOURCE_TYPES.has(location.sourceType)) score += 20;
  if (location.identityStatus === "canonical") score += 10;
  score += Math.min(10, location.evidenceSourceCount || 0);
  return score;
}

function trustedParentGroups(rows = []) {
  const trusted = rows.filter(hasTrustedCanonicalParentEvidence);
  const sets = disjointSet(trusted.length);
  for (let left = 0; left < trusted.length; left += 1) {
    for (let right = left + 1; right < trusted.length; right += 1) {
      if (sameCanonicalParent(trusted[left], trusted[right])) sets.union(left, right);
    }
  }
  const grouped = new Map();
  for (let index = 0; index < trusted.length; index += 1) {
    const root = sets.find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(trusted[index]);
  }
  return [...grouped.values()].map((members) => ({
    members,
    representative: [...members].sort((a, b) => trustScore(b) - trustScore(a))[0],
  }));
}

function emptyRetailer(retailerId) {
  return {
    retailer: retailerId,
    rawTotal: 0,
    uniqueCanonicalParentTotal: 0,
    retainedCanonicalParentTotal: 0,
    publicBefore: 0,
    eligibleAfter: 0,
    directoryOnly: 0,
    excluded: 0,
    unresolved: 0,
    duplicatesReconciled: 0,
    childServicesReconciled: 0,
    echoEligibleAfter: 0,
    rawPublicDelta: 0,
    qualityAdjustedPublicDelta: 0,
    rawSurvivalPct: null,
    qualityAdjustedSurvivalPct: null,
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function compactLocation(location = {}) {
  return {
    id: location.id || null,
    retailer: location.retailerId || null,
    provider: location.provider || null,
    name: location.name || null,
    postcode: location.postcode || null,
    verification: location.verification || null,
    identityStatus: location.identityStatus || null,
    visibilityClass: location.visibilityClass || null,
    visibilityReason: location.visibilityReason || null,
    parentLocationId: location.parentLocationId || null,
    relationshipType: location.relationshipType || null,
  };
}

export function buildQualityAdjustedLocalRadarCensus(rawRows = [], {
  echoEvents = [],
  now = Date.now(),
  sampleLimit = 40,
} = {}) {
  const input = Array.isArray(rawRows) ? rawRows : [];
  const normalized = input.map(normalizeAuditRow).filter((row) => row.id && row.retailerId);
  const invalidCount = input.length - normalized.length;
  const reconciled = reconcileLocationQuality(normalized);
  const byId = new Map(reconciled.map((row) => [row.id, row]));
  const retailers = new Map();

  for (const row of normalized) {
    const summary = retailers.get(row.retailerId) || emptyRetailer(row.retailerId);
    summary.rawTotal += 1;
    if (legacyPublicEligible(row)) summary.publicBefore += 1;
    retailers.set(row.retailerId, summary);
  }

  for (const row of reconciled) {
    const summary = retailers.get(row.retailerId) || emptyRetailer(row.retailerId);
    if (row.visibilityClass === "eligible") summary.eligibleAfter += 1;
    else if (row.visibilityClass === "directory-only") summary.directoryOnly += 1;
    else if (row.visibilityClass === "excluded") summary.excluded += 1;
    else summary.unresolved += 1;
    if (row.relationshipType === "duplicate_of") summary.duplicatesReconciled += 1;
    if (row.relationshipType === "child_service") summary.childServicesReconciled += 1;
    retailers.set(row.retailerId, summary);
  }

  const groups = trustedParentGroups(normalized);
  const lostCanonicalParents = [];
  for (const group of groups) {
    const retailerId = group.representative.retailerId;
    const summary = retailers.get(retailerId) || emptyRetailer(retailerId);
    summary.uniqueCanonicalParentTotal += 1;
    const represented = reconciled.some((candidate) => candidate.visibilityClass === "eligible"
      && group.members.some((member) => sameCanonicalParent(member, candidate)));
    if (represented) summary.retainedCanonicalParentTotal += 1;
    else {
      const related = reconciled.filter((candidate) => group.members.some((member) => sameCanonicalParent(member, candidate)));
      lostCanonicalParents.push({
        ...compactLocation(group.representative),
        related: related.map(compactLocation),
      });
    }
    retailers.set(retailerId, summary);
  }

  const echoIds = new Set();
  for (const event of Array.isArray(echoEvents) ? echoEvents : []) {
    const locationId = text(event.locationId ?? event.location_id);
    const location = locationId ? byId.get(locationId) : null;
    if (!location || !isEchoEligibleLocation(location, event, now)) continue;
    echoIds.add(locationId);
  }
  for (const locationId of echoIds) {
    const location = byId.get(locationId);
    const summary = retailers.get(location.retailerId) || emptyRetailer(location.retailerId);
    summary.echoEligibleAfter += 1;
    retailers.set(location.retailerId, summary);
  }

  const reasonCounts = {};
  for (const row of reconciled) {
    reasonCounts[row.visibilityReason || "unknown"] = Number(reasonCounts[row.visibilityReason || "unknown"] || 0) + 1;
  }

  for (const summary of retailers.values()) {
    summary.rawPublicDelta = summary.eligibleAfter - summary.publicBefore;
    summary.qualityAdjustedPublicDelta = summary.retainedCanonicalParentTotal - summary.uniqueCanonicalParentTotal;
    summary.rawSurvivalPct = ratio(summary.eligibleAfter, summary.publicBefore);
    summary.qualityAdjustedSurvivalPct = ratio(summary.retainedCanonicalParentTotal, summary.uniqueCanonicalParentTotal);
  }

  const weakDiscoveryEligible = reconciled.filter((row) => row.visibilityClass === "eligible"
    && discoveryProvider(row)
    && !hasTrustedCanonicalParentEvidence(row));
  const providerDiscoveryRows = reconciled.filter(discoveryProvider);
  const providerDiscoveryUnresolved = providerDiscoveryRows.filter((row) => row.visibilityClass === "unresolved");
  const obviousNoiseEligible = reconciled.filter((row) => row.visibilityClass === "eligible"
    && Boolean(locationServiceKind(row)));
  const provisionalEligible = reconciled.filter((row) => row.visibilityClass === "eligible"
    && normalizeLocationPolicy(row).identityStatus === "provisional");

  const retailerRows = [...retailers.values()].sort((a, b) => a.retailer.localeCompare(b.retailer));
  const totals = retailerRows.reduce((acc, row) => {
    for (const field of [
      "rawTotal",
      "uniqueCanonicalParentTotal",
      "retainedCanonicalParentTotal",
      "publicBefore",
      "eligibleAfter",
      "directoryOnly",
      "excluded",
      "unresolved",
      "duplicatesReconciled",
      "childServicesReconciled",
      "echoEligibleAfter",
    ]) acc[field] += Number(row[field] || 0);
    return acc;
  }, emptyRetailer("TOTAL"));
  totals.rawPublicDelta = totals.eligibleAfter - totals.publicBefore;
  totals.qualityAdjustedPublicDelta = totals.retainedCanonicalParentTotal - totals.uniqueCanonicalParentTotal;
  totals.rawSurvivalPct = ratio(totals.eligibleAfter, totals.publicBefore);
  totals.qualityAdjustedSurvivalPct = ratio(totals.retainedCanonicalParentTotal, totals.uniqueCanonicalParentTotal);

  const removedNoise = reconciled.filter((row) => row.visibilityClass !== "eligible" && Boolean(locationServiceKind(row)));
  const duplicates = reconciled.filter((row) => row.relationshipType === "duplicate_of");
  const childServices = reconciled.filter((row) => row.relationshipType === "child_service");
  const unresolved = reconciled.filter((row) => row.visibilityClass === "unresolved");
  const findingCounts = {
    removedNoise: removedNoise.length,
    duplicateReconciliations: duplicates.length,
    childServiceReconciliations: childServices.length,
    unresolved: unresolved.length,
    providerDiscoveryRows: providerDiscoveryRows.length,
    providerDiscoveryUnresolved: providerDiscoveryUnresolved.length,
    weakDiscoveryEligible: weakDiscoveryEligible.length,
    obviousNoiseEligible: obviousNoiseEligible.length,
    provisionalEligible: provisionalEligible.length,
    lostCanonicalParents: lostCanonicalParents.length,
  };

  return {
    totals,
    retailers: retailerRows,
    exclusionCountsByReason: reasonCounts,
    findingCounts,
    samples: {
      removedNoise: removedNoise.slice(0, sampleLimit).map(compactLocation),
      duplicateReconciliations: duplicates.slice(0, sampleLimit).map(compactLocation),
      childServiceReconciliations: childServices.slice(0, sampleLimit).map(compactLocation),
      unresolved: unresolved.slice(0, sampleLimit).map(compactLocation),
      providerDiscoveryUnresolved: providerDiscoveryUnresolved.slice(0, sampleLimit).map(compactLocation),
      weakDiscoveryEligible: weakDiscoveryEligible.slice(0, sampleLimit).map(compactLocation),
      obviousNoiseEligible: obviousNoiseEligible.slice(0, sampleLimit).map(compactLocation),
      provisionalEligible: provisionalEligible.slice(0, sampleLimit).map(compactLocation),
      lostCanonicalParents: lostCanonicalParents.slice(0, sampleLimit),
    },
    diagnostics: {
      inputRows: input.length,
      normalizedRows: normalized.length,
      invalidRows: invalidCount,
      trustedCanonicalParentRule: "Independent denominator: branch-level official/curated verification or source provenance, or explicit canonical identity with accepted evidence; service, closed, provisional, conflicted and seller-excluded records do not qualify. It never uses visibilityClass=eligible as denominator evidence.",
      rawMetricRule: "Raw survival is preserved as eligibleAfter/publicBefore using the legacy public gate; no arbitrary minimum survival target is applied.",
      historyMutation: false,
      databaseMode: "read_only_or_no_database_access",
    },
  };
}
