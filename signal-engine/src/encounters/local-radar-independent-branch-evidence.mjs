import fs from "node:fs";

import { locationServiceKind } from "./local-radar-location-policy.mjs";

const DEFAULT_PLAN_URL = new URL("./data/local-radar-independent-branch-evidence-2026-09-01.json", import.meta.url);
const STRONGER_CURRENT_VERIFICATIONS = new Set([
  "official_retailer_branch",
  "curated_branch",
  "operator_verified",
  "independently_reconciled",
  "canonical_reconciled",
]);

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

function slug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
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

function currentVerification(location = {}) {
  return lower(location.verification ?? location.verificationStatus ?? location.verification_status);
}

function hasStrongerCurrentEvidence(location = {}) {
  const verification = currentVerification(location);
  if (verification && STRONGER_CURRENT_VERIFICATIONS.has(verification)) return true;
  const openingDetails = location.openingDetails ?? location.opening_details_json ?? {};
  return openingDetails?.canonicalReconciled === true
    || openingDetails?.identityReconciled === true
    || lower(openingDetails?.sourceType) === "official_retailer_branch_page"
    || lower(openingDetails?.sourceType) === "official_branch_page"
    || lower(openingDetails?.sourceType) === "official_retailer_directory"
    || lower(openingDetails?.sourceType) === "operator_manual";
}

function safePlanPolicy(plan = {}) {
  return plan?.policy?.purpose === "branch_identity_corroboration_only"
    && plan?.policy?.providerDiscoveryAloneCanonical === false
    && plan?.policy?.productionDatabaseTouched === false
    && plan?.policy?.stockStatus === "UNKNOWN"
    && plan?.policy?.stockClaim === false
    && plan?.policy?.echoAuthorityCreated === false;
}

export function validateIndependentBranchEvidencePlan(plan = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Independent branch evidence plan must be an object");
  if (!safePlanPolicy(plan)) throw new Error("Independent branch evidence plan violates fail-closed policy");
  if (!Array.isArray(plan.parents) || !Array.isArray(plan.duplicates)) {
    throw new Error("Independent branch evidence plan requires parents and duplicates arrays");
  }
  const parentIds = new Set();
  for (const parent of plan.parents) {
    if (!text(parent?.locationId) || !text(parent?.retailerId) || !text(parent?.provider)) {
      throw new Error("Independent branch evidence parent is missing canonical snapshot identity");
    }
    if (parent.verification !== "independently_reconciled") throw new Error("Independent branch evidence parent verification is not independently_reconciled");
    if (parent.stockStatus !== "UNKNOWN" || parent.stockClaim !== false || parent.echoAuthority !== false) {
      throw new Error("Independent branch evidence parent attempted to create stock or Echo authority");
    }
    if (parentIds.has(parent.locationId)) throw new Error(`Duplicate parent location in evidence plan: ${parent.locationId}`);
    parentIds.add(parent.locationId);
  }
  const duplicateIds = new Set();
  for (const duplicate of plan.duplicates) {
    if (!text(duplicate?.locationId) || !text(duplicate?.parentLocationId)) {
      throw new Error("Independent branch evidence duplicate is missing location identity");
    }
    if (!parentIds.has(duplicate.parentLocationId)) {
      throw new Error(`Independent branch evidence duplicate points to unknown parent: ${duplicate.parentLocationId}`);
    }
    if (duplicate.stockStatus !== "UNKNOWN" || duplicate.stockClaim !== false || duplicate.echoAuthority !== false) {
      throw new Error("Independent branch evidence duplicate attempted to create stock or Echo authority");
    }
    if (parentIds.has(duplicate.locationId) || duplicateIds.has(duplicate.locationId)) {
      throw new Error(`Location appears more than once in evidence plan: ${duplicate.locationId}`);
    }
    duplicateIds.add(duplicate.locationId);
  }
  return plan;
}

export function loadIndependentBranchEvidencePlan(fileUrl = DEFAULT_PLAN_URL) {
  const plan = JSON.parse(fs.readFileSync(fileUrl, "utf8"));
  return validateIndependentBranchEvidencePlan(plan);
}

function snapshotMatches(location, snapshot, maxDriftMiles) {
  if (text(location?.id) !== text(snapshot?.locationId)) return false;
  if (text(location?.retailerId ?? location?.retailer_id) !== text(snapshot?.retailerId)) return false;
  if (lower(location?.provider) !== lower(snapshot?.provider)) return false;
  if (slug(location?.name) !== slug(snapshot?.legacyName)) return false;
  if (locationServiceKind(location)) return false;

  const currentPostcode = postcodeKey(location?.postcode);
  const snapshotPostcode = postcodeKey(snapshot?.legacyPostcode);
  if (currentPostcode && snapshotPostcode && currentPostcode !== snapshotPostcode) return false;

  const current = { latitude: number(location?.latitude), longitude: number(location?.longitude) };
  const previous = { latitude: number(snapshot?.legacyLatitude), longitude: number(snapshot?.legacyLongitude) };
  const drift = distanceMiles(current, previous);
  return drift != null && drift <= maxDriftMiles;
}

function sourceCheckedAtSeconds(parent) {
  const raw = text(parent?.sourceCheckedDate);
  if (!raw) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function parentOverlay(location, parent) {
  const openingDetails = location.openingDetails && typeof location.openingDetails === "object"
    ? { ...location.openingDetails }
    : {};
  const currentFormat = lower(location.storeFormat ?? location.store_format ?? openingDetails.storeFormat);
  return {
    ...location,
    verification: "independently_reconciled",
    identityStatus: "canonical",
    evidenceSourceCount: Math.max(Number(location.evidenceSourceCount || 0), Number(parent.evidenceSourceCountFloor || 2)),
    lastVerifiedAt: sourceCheckedAtSeconds(parent) ?? location.lastVerifiedAt ?? null,
    storeFormat: !currentFormat || currentFormat === "unknown" ? (text(parent.storeFormat) || "unknown") : location.storeFormat,
    openingDetails: {
      ...openingDetails,
      canonicalReconciled: true,
      identityReconciled: true,
      sourceType: "independent_branch_reconciliation",
      independentSourceProvider: parent.sourceProvider,
      independentSourceUrl: parent.sourceUrl,
      independentSourceFreshness: parent.sourceFreshness,
      independentSourceCheckedDate: parent.sourceCheckedDate,
      independentMasterKey: parent.masterKey,
      independentMatchType: parent.matchType,
      independentMatchDistanceMiles: parent.distanceMiles,
      stockStatus: openingDetails.stockStatus || "unknown",
      stockClaim: false,
    },
  };
}

function duplicateOverlay(location, duplicate) {
  return {
    ...location,
    visibilityClass: "excluded",
    visibilityReason: "duplicate_independent_branch_reconciliation",
    parentLocationId: duplicate.parentLocationId,
    relationshipType: "duplicate_of",
  };
}

export function applyIndependentBranchEvidence(locations = [], {
  plan = loadIndependentBranchEvidencePlan(),
} = {}) {
  validateIndependentBranchEvidencePlan(plan);
  const maxDriftMiles = Math.max(0, Number(plan?.policy?.runtimeLegacyCoordinateDriftMiles ?? 0.05));
  const parents = new Map(plan.parents.map((row) => [row.locationId, row]));
  const duplicates = new Map(plan.duplicates.map((row) => [row.locationId, row]));
  const output = [];
  const audit = {
    parentsApplied: 0,
    duplicatesApplied: 0,
    skippedStrongerEvidence: 0,
    skippedSnapshotDrift: 0,
    untouched: 0,
  };

  for (const location of Array.isArray(locations) ? locations : []) {
    if (!location || typeof location !== "object") {
      output.push(location);
      audit.untouched += 1;
      continue;
    }
    const parent = parents.get(text(location.id));
    const duplicate = duplicates.get(text(location.id));
    if (!parent && !duplicate) {
      output.push(location);
      audit.untouched += 1;
      continue;
    }
    if (hasStrongerCurrentEvidence(location) || currentVerification(location) !== "provider_discovered") {
      output.push(location);
      audit.skippedStrongerEvidence += 1;
      continue;
    }
    const snapshot = parent || duplicate;
    if (!snapshotMatches(location, snapshot, maxDriftMiles)) {
      output.push(location);
      audit.skippedSnapshotDrift += 1;
      continue;
    }
    if (parent) {
      output.push(parentOverlay(location, parent));
      audit.parentsApplied += 1;
    } else {
      output.push(duplicateOverlay(location, duplicate));
      audit.duplicatesApplied += 1;
    }
  }

  return { locations: output, audit };
}
