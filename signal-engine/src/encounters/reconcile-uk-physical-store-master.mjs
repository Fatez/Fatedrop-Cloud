import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { locationPolicyForRetailer } from "./local-radar-location-policy.mjs";

const UK_BOUNDS = Object.freeze({ minLatitude: 49, maxLatitude: 61.1, minLongitude: -9, maxLongitude: 2.5 });
const TCG_ELIGIBILITY = new Set(["OFFICIAL_POKEMON_RETAILER", "CONFIRMED_TCG_RETAILER", "LIKELY_TCG_RETAILER"]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeMasterPostcode(value) {
  const compact = String(value || "").toUpperCase().replace(/\s+/g, "");
  if (!/^(?:GIR0AA|[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2})$/.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

export function masterCanonicalKey(retailerId, postcode) {
  const normalized = normalizeMasterPostcode(postcode);
  return retailerId && normalized ? `${String(retailerId).trim()}|${normalized.replace(/\s+/g, "")}` : null;
}

export function parseMasterCsv(csvText) {
  const records = [];
  let record = [];
  let value = "";
  let quoted = false;
  const input = String(csvText || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(value);
      value = "";
    } else if (character === "\n") {
      record.push(value.replace(/\r$/, ""));
      records.push(record);
      record = [];
      value = "";
    } else value += character;
  }
  if (quoted) throw new Error("Master CSV contains an unterminated quoted field");
  if (value || record.length) {
    record.push(value.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers, ...rows] = records.filter((row) => row.some((cell) => cell !== ""));
  if (!headers?.length) return [];
  return rows.map((row, index) => ({
    __row: index + 2,
    ...Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ""])),
  }));
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

function sellerPolicy(eligibility, retailerId) {
  if (eligibility === "OFFICIAL_POKEMON_RETAILER") return { tcgSellerStatus: "likely", tcgSellerConfidence: 85 };
  if (eligibility === "CONFIRMED_TCG_RETAILER") return { tcgSellerStatus: "likely", tcgSellerConfidence: 70 };
  if (eligibility === "LIKELY_TCG_RETAILER") return { tcgSellerStatus: "likely", tcgSellerConfidence: 55 };
  const fallback = locationPolicyForRetailer(retailerId);
  return { tcgSellerStatus: "candidate", tcgSellerConfidence: Math.min(25, fallback.tcgSellerConfidence) };
}

function normalizeMasterRow(row) {
  const retailerId = text(row["Canonical Retailer ID"]);
  const postcode = normalizeMasterPostcode(row.Postcode);
  const latitude = number(row.Latitude);
  const longitude = number(row.Longitude);
  const eligibility = text(row["TCG Eligibility"])?.toUpperCase();
  const policy = locationPolicyForRetailer(retailerId);
  const seller = sellerPolicy(eligibility, retailerId);
  const checkedAt = Date.parse(`${text(row["Source Checked Date"]) || "invalid"}T00:00:00Z`);
  return {
    row: row.__row,
    key: masterCanonicalKey(retailerId, postcode),
    declaredKey: text(row["Duplicate Key"]),
    retailerId,
    name: text(row["Branch Name"]),
    address: text(row.Address),
    postcode,
    latitude,
    longitude,
    provider: text(row["Source Type"])?.toLowerCase(),
    providerId: masterCanonicalKey(retailerId, postcode),
    website: text(row["Official / Dataset Source URL"]),
    verification: text(row["Source Freshness"]) === "CURRENT_OFFICIAL" ? "official_retailer_branch" : "provider_discovered",
    retailerCategory: policy.retailerCategory,
    storeFormat: text(row["Store Format"]) || "unknown",
    operationalStatus: /^OPEN(?:_|$)/.test(text(row["Current Status"]) || "") ? "open" : "unknown",
    ...seller,
    identityStatus: "canonical",
    lastVerifiedAt: Number.isFinite(checkedAt) ? Math.floor(checkedAt / 1000) : null,
    evidence: {
      eligibility,
      detail: text(row["TCG Evidence"]),
      sourceType: text(row["Source Type"]),
      sourceFreshness: text(row["Source Freshness"]),
      importScope: "branch_identity_only",
      stockStatus: "unknown",
      stockClaim: false,
    },
    raw: row,
  };
}

function validateMasterLocation(location) {
  const reasons = [];
  if (!location.retailerId) reasons.push("retailer_id_missing");
  if (!location.name) reasons.push("branch_name_missing");
  if (!location.postcode) reasons.push("postcode_invalid");
  if (!location.key) reasons.push("canonical_key_missing");
  if (location.key && location.declaredKey !== location.key) reasons.push("canonical_key_mismatch");
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) reasons.push("coordinates_invalid");
  else if (
    location.latitude < UK_BOUNDS.minLatitude || location.latitude > UK_BOUNDS.maxLatitude
    || location.longitude < UK_BOUNDS.minLongitude || location.longitude > UK_BOUNDS.maxLongitude
  ) reasons.push("coordinates_outside_uk_bounds");
  if (text(location.raw.Country) !== "United Kingdom") reasons.push("country_not_united_kingdom");
  if (text(location.raw["Physical Stock Status"])?.toUpperCase() !== "UNKNOWN") reasons.push("physical_stock_must_be_unknown");
  if (text(location.raw["Stock Claim"])?.toLowerCase() !== "false") reasons.push("stock_claim_must_be_false");
  if (text(location.raw["Import Ready"])?.toUpperCase() !== "YES") reasons.push("source_not_import_ready");
  if (!TCG_ELIGIBILITY.has(location.evidence.eligibility)) reasons.push("tcg_eligibility_unrecognised");
  if (!location.provider || !location.website || !location.lastVerifiedAt) reasons.push("source_evidence_incomplete");
  return reasons;
}

function canonicalExistingLocation(row = {}) {
  const latitude = number(row.latitude);
  const longitude = number(row.longitude);
  const retailerId = text(row.retailerId ?? row.retailer_id);
  const postcode = normalizeMasterPostcode(row.postcode);
  return {
    id: text(row.id),
    retailerId,
    postcode,
    key: masterCanonicalKey(retailerId, postcode),
    name: text(row.name),
    latitude,
    longitude,
  };
}

export function reconcilePhysicalStoreMaster({ csvText, existingLocations = [] } = {}) {
  const rows = parseMasterCsv(csvText);
  const accepted = [];
  const rejected = [];
  const sourceKeys = new Map();
  for (const row of rows) {
    const location = normalizeMasterRow(row);
    const reasons = validateMasterLocation(location);
    if (reasons.length) {
      rejected.push({ row: location.row, key: location.key, reasons });
      continue;
    }
    if (sourceKeys.has(location.key)) {
      rejected.push({ row: location.row, key: location.key, reasons: ["duplicate_source_canonical_key"], firstRow: sourceKeys.get(location.key) });
      continue;
    }
    sourceKeys.set(location.key, location.row);
    accepted.push(location);
  }

  const existing = (Array.isArray(existingLocations) ? existingLocations : []).map(canonicalExistingLocation).filter((row) => row.id && row.retailerId);
  const existingByKey = new Map();
  for (const location of existing) {
    if (!location.key) continue;
    const matches = existingByKey.get(location.key) || [];
    matches.push(location);
    existingByKey.set(location.key, matches);
  }

  const duplicatesSkipped = [];
  const conflicts = [];
  const proposedInserts = [];
  for (const candidate of accepted) {
    const exact = existingByKey.get(candidate.key) || [];
    if (exact.length === 1) {
      const miles = distanceMiles(candidate, exact[0]);
      if (miles != null && miles > 1) {
        conflicts.push({
          key: candidate.key,
          type: "canonical_key_coordinate_conflict",
          candidateRow: candidate.row,
          existingIds: [exact[0].id],
          distanceMiles: Number(miles.toFixed(3)),
        });
      } else {
        duplicatesSkipped.push({ key: candidate.key, existingId: exact[0].id, candidateRow: candidate.row, matchedBy: "canonical_key" });
      }
      continue;
    }
    if (exact.length > 1) {
      conflicts.push({ key: candidate.key, type: "duplicate_existing_canonical_key", candidateRow: candidate.row, existingIds: exact.map((row) => row.id) });
      continue;
    }

    const nearby = existing.filter((location) => {
      if (location.retailerId !== candidate.retailerId) return false;
      const miles = distanceMiles(candidate, location);
      return miles != null && miles <= 0.15;
    });
    if (nearby.length) {
      conflicts.push({
        key: candidate.key,
        type: "nearby_same_retailer_requires_review",
        candidateRow: candidate.row,
        existingIds: nearby.map((row) => row.id),
        distancesMiles: nearby.map((row) => Number(distanceMiles(candidate, row).toFixed(3))),
      });
      continue;
    }
    proposedInserts.push(candidate);
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry_run_no_writes",
    policy: {
      canonicalKey: "canonical retailer id + normalized postcode",
      proximityConflictMiles: 0.15,
      stockStatus: "unknown",
      stockClaim: false,
      conflicts: "quarantine rather than guess",
    },
    counts: {
      sourceRows: rows.length,
      validSourceRows: accepted.length,
      existingCanonicalLocations: existing.length,
      existingCanonicalKeys: existingByKey.size,
      duplicatesSkipped: duplicatesSkipped.length,
      conflicts: conflicts.length,
      rejected: rejected.length,
      proposedInserts: proposedInserts.length,
    },
    existingCanonicalKeys: [...existingByKey.keys()].sort(),
    newCanonicalKeys: proposedInserts.map((row) => row.key).sort(),
    duplicatesSkipped,
    conflicts,
    rejected,
    proposedInserts: proposedInserts.map(({ raw, ...location }) => location),
  };
}

async function main() {
  const masterPath = process.argv[2];
  const existingPath = process.argv[3] || null;
  const outputPath = process.argv[4] || path.resolve(process.cwd(), "artifacts", "uk-physical-store-reconciliation.json");
  if (!masterPath) throw new Error("Usage: node reconcile-uk-physical-store-master.mjs <master.csv> [existing-locations.json] [output.json]");
  const csvText = await fs.readFile(path.resolve(masterPath), "utf8");
  const existingLocations = existingPath ? JSON.parse(await fs.readFile(path.resolve(existingPath), "utf8")) : [];
  const report = reconcilePhysicalStoreMaster({ csvText, existingLocations });
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
