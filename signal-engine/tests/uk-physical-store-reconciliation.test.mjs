import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMasterPostcode,
  parseMasterCsv,
  reconcilePhysicalStoreMaster,
} from "../src/encounters/reconcile-uk-physical-store-master.mjs";

const HEADERS = [
  "Retailer", "Canonical Retailer ID", "Branch Name", "Host Retailer", "Store Relationship", "Address",
  "Town / City", "County / Region", "Postcode", "Country", "Latitude", "Longitude", "Store Format",
  "Current Status", "TCG Eligibility", "TCG Evidence", "Physical Stock Status", "Stock Claim", "Duplicate Key",
  "Official / Dataset Source URL", "Source Type", "Source Checked Date", "Source Freshness", "Import Ready", "Notes",
];

function csvRow({ retailer = "Tesco", retailerId = "tesco-uk", name = "Tesco Test", postcode = "EN1 3RW", latitude = 51.65, longitude = -0.06, stock = "UNKNOWN", stockClaim = "false" } = {}) {
  const values = {
    Retailer: retailer,
    "Canonical Retailer ID": retailerId,
    "Branch Name": name,
    Address: "1 Test Road",
    Postcode: postcode,
    Country: "United Kingdom",
    Latitude: latitude,
    Longitude: longitude,
    "Store Format": retailer,
    "Current Status": "OPEN_BASELINE",
    "TCG Eligibility": "LIKELY_TCG_RETAILER",
    "TCG Evidence": "Location evidence only",
    "Physical Stock Status": stock,
    "Stock Claim": stockClaim,
    "Duplicate Key": `${retailerId}|${postcode.replace(/\s+/g, "").toUpperCase()}`,
    "Official / Dataset Source URL": "https://example.test/source",
    "Source Type": "GEOLYTIX_RETAIL_POINTS",
    "Source Checked Date": "2026-08-30",
    "Source Freshness": "GEOLYTIX_TEST",
    "Import Ready": "YES",
  };
  return HEADERS.map((header) => values[header] ?? "").join(",");
}

function csv(rows) {
  return `${HEADERS.join(",")}\n${rows.join("\n")}\n`;
}

test("CSV parser preserves quoted branch names", () => {
  const parsed = parseMasterCsv(`${HEADERS.join(",")}\n${csvRow({ name: 'Tesco "Extra", Enfield' }).replace('Tesco "Extra", Enfield', '"Tesco ""Extra"", Enfield"')}\n`);
  assert.equal(parsed[0]["Branch Name"], 'Tesco "Extra", Enfield');
});

test("reconciliation accepts the valid non-geographic GIR postcode", () => {
  assert.equal(normalizeMasterPostcode("GIR 0AA"), "GIR 0AA");
});

test("exact canonical key preserves existing branch identity and skips insert", () => {
  const report = reconcilePhysicalStoreMaster({
    csvText: csv([csvRow()]),
    existingLocations: [{ id: "loc_existing", retailerId: "tesco-uk", postcode: "EN13RW", latitude: 51.6501, longitude: -0.0601 }],
  });
  assert.equal(report.counts.duplicatesSkipped, 1);
  assert.equal(report.counts.proposedInserts, 0);
  assert.equal(report.duplicatesSkipped[0].existingId, "loc_existing");
});

test("nearby same-retailer branch with a missing canonical postcode is quarantined", () => {
  const report = reconcilePhysicalStoreMaster({
    csvText: csv([csvRow()]),
    existingLocations: [{ id: "loc_incomplete", retailerId: "tesco-uk", postcode: null, latitude: 51.6501, longitude: -0.0601 }],
  });
  assert.equal(report.counts.conflicts, 1);
  assert.equal(report.counts.proposedInserts, 0);
  assert.equal(report.conflicts[0].type, "nearby_same_retailer_requires_review");
});

test("different retailers sharing a postcode remain separate physical branches", () => {
  const report = reconcilePhysicalStoreMaster({
    csvText: csv([csvRow()]),
    existingLocations: [{ id: "loc_asda", retailerId: "asda-uk", postcode: "EN1 3RW", latitude: 51.65, longitude: -0.06 }],
  });
  assert.equal(report.counts.conflicts, 0);
  assert.equal(report.counts.proposedInserts, 1);
});

test("any stock claim in a location master is rejected", () => {
  const report = reconcilePhysicalStoreMaster({ csvText: csv([csvRow({ stock: "IN_STOCK", stockClaim: "true" })]) });
  assert.equal(report.counts.rejected, 1);
  assert.deepEqual(report.rejected[0].reasons.filter((reason) => reason.includes("stock")), [
    "physical_stock_must_be_unknown",
    "stock_claim_must_be_false",
  ]);
});
