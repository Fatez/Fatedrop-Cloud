import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalKey,
  dedupeMasterRows,
  makeMasterRow,
  normalizePostcode,
} from "../src/encounters/build-uk-physical-store-master.mjs";

test("normalizes genuine UK postcodes and rejects obvious placeholders", () => {
  assert.equal(normalizePostcode("en1 3rw"), "EN1 3RW");
  assert.equal(normalizePostcode("SW1A1AA"), "SW1A 1AA");
  assert.equal(normalizePostcode("LO16 8RT"), null);
});

test("canonical identity is retailer plus normalized postcode", () => {
  assert.equal(canonicalKey("smyths-uk", "EN1 3RW"), "smyths-uk|EN13RW");
  assert.equal(canonicalKey("asda-uk", "EN1 3RW"), "asda-uk|EN13RW");
});

test("new master rows never claim physical stock", () => {
  const row = makeMasterRow({
    retailer: "Smyths Toys",
    retailerId: "smyths-uk",
    branch: "Enfield",
    postcode: "EN1 3RW",
    latitude: 51.65,
    longitude: -0.06,
    currentStatus: "OPEN",
    importReady: "YES",
  });
  assert.equal(row["Physical Stock Status"], "UNKNOWN");
  assert.equal(row["Stock Claim"], false);
});

test("same retailer and postcode dedupes, different retailer survives", () => {
  const base = {
    branch: "Test",
    postcode: "EN1 3RW",
    latitude: 51.65,
    longitude: -0.06,
    currentStatus: "OPEN",
    importReady: "YES",
  };
  const rows = [
    makeMasterRow({ ...base, retailer: "Smyths Toys", retailerId: "smyths-uk", sourceType: "GEOLYTIX_RETAIL_POINTS", sourceFreshness: "GEOLYTIX_2025" }),
    makeMasterRow({ ...base, retailer: "Smyths Toys", retailerId: "smyths-uk", sourceType: "CURRENT_OFFICIAL_BRANCH_PAGE", sourceFreshness: "CURRENT_OFFICIAL" }),
    makeMasterRow({ ...base, retailer: "ASDA", retailerId: "asda-uk", sourceType: "CURRENT_OFFICIAL_BRANCH_PAGE", sourceFreshness: "CURRENT_OFFICIAL" }),
  ];
  const result = dedupeMasterRows(rows);
  assert.equal(result.rows.length, 2);
  const smyths = result.rows.find((row) => row["Canonical Retailer ID"] === "smyths-uk");
  assert.equal(smyths["Source Type"], "CURRENT_OFFICIAL_BRANCH_PAGE");
});
