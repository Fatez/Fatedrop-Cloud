import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  masterCanonicalKey,
  normalizeMasterPostcode,
  parseMasterCsv,
} from "./reconcile-uk-physical-store-master.mjs";
import {
  classifyLocationQuality,
  locationServiceKind,
} from "./local-radar-location-policy.mjs";

const EXACT_MAX_MILES = 0.2;
const NEARBY_MAX_MILES = 0.15;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthyFalse(value) {
  return value === false || String(value ?? "").trim().toLowerCase() === "false";
}

function distanceMiles(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function publicAuditRow(shop = {}) {
  const locationEvidence = shop?.locationEvidence || {};
  return {
    ...shop,
    identityStatus: shop?.identityStatus ?? locationEvidence?.branchIdentity,
    tcgSellerStatus: shop?.tcgSellerStatus ?? locationEvidence?.pokemonSeller,
    tcgSellerConfidence: shop?.tcgSellerConfidence ?? locationEvidence?.confidence,
    evidenceSourceCount: shop?.evidenceSourceCount ?? locationEvidence?.sourceCount,
    lastVerifiedAt: shop?.lastVerifiedAt ?? locationEvidence?.lastVerifiedAt,
  };
}

function verificationOf(shop = {}) {
  return text(shop?.verificationStatus ?? shop?.verification)?.toLowerCase();
}

function isDiscoveryOnlyCandidate(shop = {}) {
  const row = publicAuditRow(shop);
  const quality = classifyLocationQuality(row);
  return verificationOf(shop) === "provider_discovered"
    && quality.visibilityClass === "unresolved"
    && quality.reason === "provisional_identity"
    && !locationServiceKind(row);
}

function normalizeMasterEvidence(row = {}) {
  const retailerId = text(row["Canonical Retailer ID"]);
  const postcode = normalizeMasterPostcode(row.Postcode);
  const latitude = number(row.Latitude);
  const longitude = number(row.Longitude);
  const key = masterCanonicalKey(retailerId, postcode);
  const sourceType = text(row["Source Type"]);
  const sourceUrl = text(row["Official / Dataset Source URL"]);
  const sourceCheckedDate = text(row["Source Checked Date"]);
  const sourceFreshness = text(row["Source Freshness"]);
  const importReady = text(row["Import Ready"])?.toUpperCase();
  const importScope = text(row["Import Scope"])?.toUpperCase();
  const conflictStatus = text(row["Conflict Status"])?.toUpperCase();
  const physicalStockStatus = text(row["Physical Stock Status"])?.toUpperCase();
  const country = text(row.Country);
  if (!retailerId || !postcode || !key || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (!sourceType || !sourceUrl || !sourceCheckedDate || !sourceFreshness) return null;
  if (country !== "United Kingdom") return null;
  if (importReady !== "YES" || importScope !== "BRANCH_IDENTITY_ONLY") return null;
  if (conflictStatus !== "CLEAR") return null;
  if (physicalStockStatus !== "UNKNOWN" || !truthyFalse(row["Stock Claim"])) return null;
  return {
    key,
    retailerId,
    postcode,
    branch: text(row["Branch Name"]) || "Retail branch",
    latitude,
    longitude,
    storeFormat: text(row["Store Format"]) || "unknown",
    sourceProvider: sourceType,
    sourceUrl,
    sourceCheckedDate,
    sourceFreshness,
  };
}

function normalizeLegacyCandidate(shop = {}) {
  const id = text(shop?.id);
  const retailerId = text(shop?.retailerId ?? shop?.retailer_id);
  const provider = text(shop?.provider)?.toLowerCase();
  const name = text(shop?.name);
  const postcode = normalizeMasterPostcode(shop?.postcode);
  const latitude = number(shop?.latitude);
  const longitude = number(shop?.longitude);
  if (!id || !retailerId || !provider || !name) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { id, retailerId, provider, name, postcode, latitude, longitude };
}

function parentSort(left, right) {
  const leftExact = left.matchType === "exact_postcode" ? 0 : 1;
  const rightExact = right.matchType === "exact_postcode" ? 0 : 1;
  return leftExact - rightExact
    || left.distanceMiles - right.distanceMiles
    || left.location.id.localeCompare(right.location.id);
}

export function buildIndependentBranchEvidencePlan({
  legacyRows = [],
  masterCsvText = "",
  generatedAt = new Date().toISOString(),
  harvestCommit = null,
  harvestRunId = null,
} = {}) {
  const masterRows = parseMasterCsv(masterCsvText)
    .map(normalizeMasterEvidence)
    .filter(Boolean);

  const masterByKey = new Map();
  const masterByRetailer = new Map();
  for (const row of masterRows) {
    const keyed = masterByKey.get(row.key) || [];
    keyed.push(row);
    masterByKey.set(row.key, keyed);
    const retailer = masterByRetailer.get(row.retailerId) || [];
    retailer.push(row);
    masterByRetailer.set(row.retailerId, retailer);
  }

  const discovery = (Array.isArray(legacyRows) ? legacyRows : [])
    .filter(isDiscoveryOnlyCandidate)
    .map(normalizeLegacyCandidate)
    .filter(Boolean);

  const matchedByMasterKey = new Map();
  const ambiguousReview = [];
  const exactConflict = [];
  const unmatched = [];

  for (const location of discovery) {
    const exactKey = masterCanonicalKey(location.retailerId, location.postcode);
    const exact = exactKey ? (masterByKey.get(exactKey) || []) : [];
    if (exact.length === 1) {
      const miles = distanceMiles(location, exact[0]);
      if (miles != null && miles <= EXACT_MAX_MILES) {
        const matches = matchedByMasterKey.get(exact[0].key) || [];
        matches.push({ location, evidence: exact[0], matchType: "exact_postcode", distanceMiles: miles });
        matchedByMasterKey.set(exact[0].key, matches);
      } else {
        exactConflict.push({
          location,
          masterKey: exact[0].key,
          reason: miles == null ? "exact_key_coordinates_missing" : "exact_key_coordinate_conflict",
          distanceMiles: miles,
        });
      }
      continue;
    }
    if (exact.length > 1) {
      ambiguousReview.push({ location, reason: "duplicate_master_canonical_key", candidates: exact.map((row) => row.key) });
      continue;
    }

    const nearby = (masterByRetailer.get(location.retailerId) || [])
      .map((evidence) => ({ evidence, distanceMiles: distanceMiles(location, evidence) }))
      .filter((row) => row.distanceMiles != null && row.distanceMiles <= NEARBY_MAX_MILES)
      .sort((a, b) => a.distanceMiles - b.distanceMiles || a.evidence.key.localeCompare(b.evidence.key));

    if (nearby.length === 1) {
      const chosen = nearby[0];
      const matches = matchedByMasterKey.get(chosen.evidence.key) || [];
      matches.push({ location, evidence: chosen.evidence, matchType: "unique_nearby", distanceMiles: chosen.distanceMiles });
      matchedByMasterKey.set(chosen.evidence.key, matches);
    } else if (nearby.length > 1) {
      ambiguousReview.push({
        location,
        reason: "multiple_nearby_same_retailer_master_branches",
        candidates: nearby.map((row) => ({ key: row.evidence.key, distanceMiles: Number(row.distanceMiles.toFixed(3)) })),
      });
    } else {
      unmatched.push(location);
    }
  }

  const parents = [];
  const duplicates = [];
  const representedByRetailer = new Map();
  for (const [masterKey, matches] of [...matchedByMasterKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...matches].sort(parentSort);
    const keep = ordered[0];
    const evidence = keep.evidence;
    parents.push({
      locationId: keep.location.id,
      retailerId: keep.location.retailerId,
      provider: keep.location.provider,
      legacyName: keep.location.name,
      legacyPostcode: keep.location.postcode,
      legacyLatitude: keep.location.latitude,
      legacyLongitude: keep.location.longitude,
      masterKey,
      masterPostcode: evidence.postcode,
      masterBranch: evidence.branch,
      masterLatitude: evidence.latitude,
      masterLongitude: evidence.longitude,
      storeFormat: evidence.storeFormat,
      sourceType: "independent_branch_reconciliation",
      sourceProvider: evidence.sourceProvider,
      sourceFreshness: evidence.sourceFreshness,
      sourceCheckedDate: evidence.sourceCheckedDate,
      sourceUrl: evidence.sourceUrl,
      matchType: keep.matchType,
      distanceMiles: Number(keep.distanceMiles.toFixed(3)),
      verification: "independently_reconciled",
      evidenceSourceCountFloor: 2,
      stockStatus: "UNKNOWN",
      stockClaim: false,
      echoAuthority: false,
    });
    const represented = representedByRetailer.get(evidence.retailerId) || new Set();
    represented.add(masterKey);
    representedByRetailer.set(evidence.retailerId, represented);
    for (const drop of ordered.slice(1)) {
      duplicates.push({
        locationId: drop.location.id,
        retailerId: drop.location.retailerId,
        provider: drop.location.provider,
        legacyName: drop.location.name,
        legacyPostcode: drop.location.postcode,
        legacyLatitude: drop.location.latitude,
        legacyLongitude: drop.location.longitude,
        parentLocationId: keep.location.id,
        masterKey,
        reason: "duplicate_independent_branch_reconciliation",
        stockStatus: "UNKNOWN",
        stockClaim: false,
        echoAuthority: false,
      });
    }
  }

  const masterCoverageByRetailer = [...masterByRetailer.entries()]
    .map(([retailerId, rows]) => {
      const represented = representedByRetailer.get(retailerId) || new Set();
      const uniqueMasterKeys = new Set(rows.map((row) => row.key));
      return {
        retailerId,
        independentMasterBranches: uniqueMasterKeys.size,
        representedByLegacy: represented.size,
        absentFromLegacy: Math.max(0, uniqueMasterKeys.size - represented.size),
        legacyRepresentationPct: uniqueMasterKeys.size ? represented.size / uniqueMasterKeys.size : null,
      };
    })
    .sort((a, b) => a.retailerId.localeCompare(b.retailerId));

  return {
    version: "2026-09-01",
    generatedAt,
    generatedFrom: {
      harvestCommit,
      harvestRunId,
      sourceMode: "read_only_evidence_harvest_no_writes",
      legacyInputRows: Array.isArray(legacyRows) ? legacyRows.length : 0,
      masterSourceRows: masterRows.length,
    },
    policy: {
      purpose: "branch_identity_corroboration_only",
      providerDiscoveryAloneCanonical: false,
      productionDatabaseTouched: false,
      stockStatus: "UNKNOWN",
      stockClaim: false,
      echoAuthorityCreated: false,
      exactMaxMiles: EXACT_MAX_MILES,
      nearbyMaxMiles: NEARBY_MAX_MILES,
      runtimeLegacyCoordinateDriftMiles: 0.05,
      parentSelection: "Exact retailer+postcode is preferred; otherwise exactly one same-retailer master branch within 0.15 miles. Multiple legacy rows collapse to one canonical parent.",
    },
    counts: {
      discoveryOnlyCandidates: discovery.length,
      canonicalParents: parents.length,
      duplicateLegacyRows: duplicates.length,
      matchedLegacyRows: parents.length + duplicates.length,
      exactConflict: exactConflict.length,
      ambiguousReview: ambiguousReview.length,
      unmatched: unmatched.length,
    },
    masterCoverageByRetailer,
    parents,
    duplicates,
    review: {
      exactConflict,
      ambiguousReview,
      unmatched,
    },
  };
}

async function main() {
  const legacyPath = process.argv[2];
  const masterPath = process.argv[3];
  const outputPath = process.argv[4];
  if (!legacyPath || !masterPath || !outputPath) {
    throw new Error("Usage: node build-local-radar-independent-branch-evidence-plan.mjs <legacy.json> <master.csv> <output.json>");
  }
  const legacyRows = JSON.parse(await fs.readFile(path.resolve(legacyPath), "utf8"));
  const masterCsvText = await fs.readFile(path.resolve(masterPath), "utf8");
  const plan = buildIndependentBranchEvidencePlan({ legacyRows, masterCsvText });
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, counts: plan.counts, masterCoverageByRetailer: plan.masterCoverageByRetailer }, null, 2));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry && import.meta.url === entry) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
