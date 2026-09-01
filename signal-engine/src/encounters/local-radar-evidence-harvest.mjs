import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { reconcileLocationQuality } from "./canonical-retailer-locations.mjs";
import {
  masterCanonicalKey,
  normalizeMasterPostcode,
  parseMasterCsv,
} from "./reconcile-uk-physical-store-master.mjs";

const DISCOVERY_PROVIDER_RE = /(?:google(?:_places)?|openstreetmap|\bosm\b|places_discovery|provider_discovered)/i;
const OFFICIAL_SOURCE_RE = /official/i;

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

function normalizeLegacyRow(row = {}) {
  const openingDetails = row.openingDetails ?? row.opening_details_json ?? {};
  const locationEvidence = row.locationEvidence ?? row.location_evidence ?? {};
  return {
    id: text(row.id),
    retailerId: text(row.retailerId ?? row.retailer_id),
    provider: lower(row.provider) || "unknown",
    providerId: text(row.providerId ?? row.provider_id ?? row.providerPlaceId),
    name: text(row.name) || "Unknown branch",
    address: text(row.address),
    postcode: normalizeMasterPostcode(row.postcode),
    latitude: number(row.latitude),
    longitude: number(row.longitude),
    website: text(row.website ?? row.websiteUrl),
    phone: text(row.phone),
    openingDetails,
    verification: lower(row.verification ?? row.verificationStatus ?? row.verification_status) || "source_verified",
    updatedAt: number(row.updatedAt ?? row.updated_at ?? row.branchUpdatedAt),
    retailerCategory: lower(row.retailerCategory ?? row.retailer_category),
    storeFormat: lower(row.storeFormat ?? row.store_format ?? openingDetails?.storeFormat),
    operationalStatus: lower(row.operationalStatus ?? row.operational_status),
    tcgSellerStatus: lower(row.tcgSellerStatus ?? row.tcg_seller_status ?? locationEvidence.pokemonSeller),
    tcgSellerConfidence: number(row.tcgSellerConfidence ?? row.tcg_seller_confidence ?? locationEvidence.confidence),
    identityStatus: lower(row.identityStatus ?? row.identity_status ?? locationEvidence.branchIdentity),
    lastVerifiedAt: number(row.lastVerifiedAt ?? row.last_verified_at ?? locationEvidence.lastVerifiedAt),
    evidenceSourceCount: Math.max(0, Number(row.evidenceSourceCount ?? row.evidence_source_count ?? locationEvidence.sourceCount) || 0),
    sourceType: lower(row.sourceType ?? row.source_type ?? openingDetails?.sourceType),
    sourceUrl: text(row.sourceUrl ?? row.source_url ?? openingDetails?.sourceUrl),
    raw: row,
  };
}

function discoveryOnly(location = {}) {
  return location.verification === "provider_discovered"
    || DISCOVERY_PROVIDER_RE.test(location.provider || "");
}

function distanceMiles(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normalizeMasterEvidence(row = {}) {
  const retailerId = text(row["Canonical Retailer ID"]);
  const postcode = normalizeMasterPostcode(row.Postcode);
  const latitude = number(row.Latitude);
  const longitude = number(row.Longitude);
  const sourceType = text(row["Source Type"]) || "UNKNOWN";
  const sourceFreshness = text(row["Source Freshness"]) || "UNKNOWN";
  const stockStatus = text(row["Physical Stock Status"])?.toUpperCase();
  const stockClaim = text(row["Stock Claim"])?.toLowerCase();
  const importReady = text(row["Import Ready"])?.toUpperCase();
  const conflictStatus = (text(row["Conflict Status"]) || "CLEAR").toUpperCase();
  const importScope = (text(row["Import Scope"]) || "BRANCH_IDENTITY_ONLY").toUpperCase();
  const key = masterCanonicalKey(retailerId, postcode);
  const safe = Boolean(
    key
    && Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && stockStatus === "UNKNOWN"
    && stockClaim === "false"
    && importReady === "YES"
    && conflictStatus === "CLEAR"
    && importScope === "BRANCH_IDENTITY_ONLY"
  );
  return {
    row: row.__row,
    key,
    retailerId,
    branch: text(row["Branch Name"]),
    postcode,
    latitude,
    longitude,
    sourceType,
    sourceFreshness,
    sourceUrl: text(row["Official / Dataset Source URL"]),
    safe,
    official: OFFICIAL_SOURCE_RE.test(`${sourceType} ${sourceFreshness}`),
  };
}

function compactLegacy(location = {}) {
  return {
    id: location.id || null,
    retailer: location.retailerId || null,
    provider: location.provider || null,
    name: location.name || null,
    postcode: location.postcode || null,
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    verification: location.verification || null,
    visibilityClass: location.visibilityClass || null,
    visibilityReason: location.visibilityReason || null,
  };
}

function compactMaster(master = {}) {
  return {
    retailer: master.retailerId || null,
    branch: master.branch || null,
    postcode: master.postcode || null,
    latitude: master.latitude ?? null,
    longitude: master.longitude ?? null,
    sourceType: master.sourceType || null,
    sourceFreshness: master.sourceFreshness || null,
    sourceUrl: master.sourceUrl || null,
  };
}

function addRetailerCount(target, retailer, field) {
  const key = retailer || "(unknown)";
  target[key] ||= {
    unresolvedDiscovery: 0,
    exactOfficialRecovery: 0,
    exactIndependentDatasetRecovery: 0,
    exactConflict: 0,
    nearbyReview: 0,
    unmatched: 0,
  };
  target[key][field] += 1;
}

export function buildLocalRadarEvidenceHarvest({ legacyRows = [], masterCsvText = "", sampleLimit = 40 } = {}) {
  const legacyInput = Array.isArray(legacyRows) ? legacyRows : [];
  const normalized = legacyInput.map(normalizeLegacyRow).filter((row) => row.id && row.retailerId);
  const reconciled = reconcileLocationQuality(normalized);
  const currentEligible = reconciled.filter((row) => row.visibilityClass === "eligible");
  const unresolvedDiscovery = reconciled.filter((row) => row.visibilityClass === "unresolved"
    && row.visibilityReason === "provisional_identity"
    && discoveryOnly(row));

  const masterRows = parseMasterCsv(masterCsvText).map(normalizeMasterEvidence);
  const safeMasterRows = masterRows.filter((row) => row.safe);
  const masterByKey = new Map();
  const masterByRetailer = new Map();
  for (const row of safeMasterRows) {
    const exact = masterByKey.get(row.key) || [];
    exact.push(row);
    masterByKey.set(row.key, exact);
    const retailerRows = masterByRetailer.get(row.retailerId) || [];
    retailerRows.push(row);
    masterByRetailer.set(row.retailerId, retailerRows);
  }

  const exactOfficialRecovery = [];
  const exactIndependentDatasetRecovery = [];
  const exactConflict = [];
  const nearbyReview = [];
  const unmatched = [];
  const byRetailer = {};

  for (const location of unresolvedDiscovery) {
    addRetailerCount(byRetailer, location.retailerId, "unresolvedDiscovery");
    const key = masterCanonicalKey(location.retailerId, location.postcode);
    const exact = key ? (masterByKey.get(key) || []) : [];
    if (exact.length === 1) {
      const evidence = exact[0];
      const miles = distanceMiles(location, evidence);
      if (miles == null || miles > 1) {
        exactConflict.push({
          location: compactLegacy(location),
          evidence: compactMaster(evidence),
          reason: miles == null ? "exact_key_coordinates_missing" : "exact_key_coordinate_conflict",
          distanceMiles: miles == null ? null : Number(miles.toFixed(3)),
        });
        addRetailerCount(byRetailer, location.retailerId, "exactConflict");
        continue;
      }
      const item = {
        location: compactLegacy(location),
        evidence: compactMaster(evidence),
        matchedBy: "canonical_retailer_plus_postcode",
        distanceMiles: Number(miles.toFixed(3)),
        proposedVerification: evidence.official ? "official_retailer_branch" : "independently_reconciled",
        proposedEvidenceSourceCountFloor: evidence.official ? 1 : 2,
        stockStatus: "UNKNOWN",
        stockClaim: false,
        echoAuthority: false,
      };
      if (evidence.official) {
        exactOfficialRecovery.push(item);
        addRetailerCount(byRetailer, location.retailerId, "exactOfficialRecovery");
      } else {
        exactIndependentDatasetRecovery.push(item);
        addRetailerCount(byRetailer, location.retailerId, "exactIndependentDatasetRecovery");
      }
      continue;
    }
    if (exact.length > 1) {
      exactConflict.push({
        location: compactLegacy(location),
        evidence: exact.map(compactMaster),
        reason: "multiple_master_rows_for_canonical_key",
      });
      addRetailerCount(byRetailer, location.retailerId, "exactConflict");
      continue;
    }

    const nearby = (masterByRetailer.get(location.retailerId) || [])
      .map((candidate) => ({ candidate, miles: distanceMiles(location, candidate) }))
      .filter(({ miles }) => miles != null && miles <= 0.15)
      .sort((a, b) => a.miles - b.miles);
    if (nearby.length) {
      nearbyReview.push({
        location: compactLegacy(location),
        evidence: nearby.slice(0, 3).map(({ candidate, miles }) => ({
          ...compactMaster(candidate),
          distanceMiles: Number(miles.toFixed(3)),
        })),
        reason: location.postcode ? "nearby_same_retailer_postcode_mismatch_requires_review" : "postcode_missing_nearby_same_retailer_requires_review",
      });
      addRetailerCount(byRetailer, location.retailerId, "nearbyReview");
      continue;
    }
    unmatched.push(compactLegacy(location));
    addRetailerCount(byRetailer, location.retailerId, "unmatched");
  }

  const autoRecoverable = exactOfficialRecovery.length + exactIndependentDatasetRecovery.length;
  const predictedEligibleAfterEvidence = currentEligible.length + autoRecoverable;
  return {
    generatedAt: new Date().toISOString(),
    mode: "read_only_evidence_harvest_no_writes",
    policy: {
      productionDatabaseTouched: false,
      masterImportScope: "branch_identity_only",
      providerDiscoveryAloneCanonical: false,
      exactIndependentDatasetMatch: "may establish canonical identity only as independently reconciled evidence",
      proximityOnlyMatch: "review_only_never_auto_canonical",
      stockStatus: "UNKNOWN",
      stockClaim: false,
      echoAuthorityCreated: false,
      conflicts: "quarantine rather than guess",
    },
    counts: {
      legacyInputRows: legacyInput.length,
      normalizedLegacyRows: normalized.length,
      currentEligible: currentEligible.length,
      unresolvedDiscovery: unresolvedDiscovery.length,
      masterSourceRows: masterRows.length,
      safeMasterRows: safeMasterRows.length,
      exactOfficialRecovery: exactOfficialRecovery.length,
      exactIndependentDatasetRecovery: exactIndependentDatasetRecovery.length,
      autoRecoverable,
      exactConflict: exactConflict.length,
      nearbyReview: nearbyReview.length,
      unmatched: unmatched.length,
      predictedEligibleAfterEvidence,
      predictedRawSurvivalPct: legacyInput.length ? predictedEligibleAfterEvidence / legacyInput.length : null,
    },
    byRetailer: Object.entries(byRetailer)
      .map(([retailer, counts]) => ({ retailer, ...counts }))
      .sort((a, b) => a.retailer.localeCompare(b.retailer)),
    samples: {
      exactOfficialRecovery: exactOfficialRecovery.slice(0, sampleLimit),
      exactIndependentDatasetRecovery: exactIndependentDatasetRecovery.slice(0, sampleLimit),
      exactConflict: exactConflict.slice(0, sampleLimit),
      nearbyReview: nearbyReview.slice(0, sampleLimit),
      unmatched: unmatched.slice(0, sampleLimit),
    },
    recovery: {
      exactOfficialRecovery,
      exactIndependentDatasetRecovery,
      exactConflict,
      nearbyReview,
    },
  };
}

async function main() {
  const legacyPath = process.argv[2];
  const masterPath = process.argv[3];
  const outputPath = process.argv[4] || path.resolve(process.cwd(), "artifacts", "local-radar-evidence-harvest.json");
  if (!legacyPath || !masterPath) {
    throw new Error("Usage: node local-radar-evidence-harvest.mjs <legacy-rows.json> <master.csv> [output.json]");
  }
  const legacyRows = JSON.parse(await fs.readFile(path.resolve(legacyPath), "utf8"));
  const masterCsvText = await fs.readFile(path.resolve(masterPath), "utf8");
  const report = buildLocalRadarEvidenceHarvest({ legacyRows, masterCsvText });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...report.counts }, null, 2));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry && import.meta.url === entry) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
