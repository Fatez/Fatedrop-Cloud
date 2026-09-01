import assert from "node:assert/strict";
import test from "node:test";

import { buildLocalRadarEvidenceHarvest } from "../src/encounters/local-radar-evidence-harvest.mjs";

const legacyRows = [
  {
    id: "tesco-dataset-match",
    retailerId: "tesco-uk",
    provider: "openstreetmap",
    providerId: "osm:1",
    name: "Tesco Extra Watford",
    postcode: "WD17 1AA",
    latitude: 51.656,
    longitude: -0.395,
    storeFormat: "superstore",
    verification: "provider_discovered",
    identityStatus: "canonical",
    openingDetails: { stockStatus: "unknown", lifecycleHistory: ["echo:historical"] },
  },
  {
    id: "entertainer-official-match",
    retailerId: "entertainer-uk",
    provider: "openstreetmap",
    providerId: "osm:2",
    name: "The Entertainer Brighton",
    postcode: "BN1 2TF",
    latitude: 50.822,
    longitude: -0.143,
    storeFormat: "toy_store",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "argos-unmatched",
    retailerId: "argos-uk",
    provider: "openstreetmap",
    providerId: "osm:3",
    name: "Argos Example",
    postcode: "N1 9AA",
    latitude: 51.53,
    longitude: -0.11,
    storeFormat: "general_retail",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "tesco-coordinate-conflict",
    retailerId: "tesco-uk",
    provider: "openstreetmap",
    providerId: "osm:4",
    name: "Tesco Conflict",
    postcode: "E1 8AL",
    latitude: 51.7,
    longitude: -0.4,
    storeFormat: "superstore",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "tesco-nearby-review",
    retailerId: "tesco-uk",
    provider: "openstreetmap",
    providerId: "osm:5",
    name: "Tesco Nearby",
    postcode: null,
    latitude: 51.451,
    longitude: -0.123,
    storeFormat: "superstore",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "tesco-pharmacy",
    retailerId: "tesco-uk",
    provider: "openstreetmap",
    providerId: "osm:6",
    name: "Tesco Watford Pharmacy",
    postcode: "WD17 1AA",
    latitude: 51.65601,
    longitude: -0.39501,
    storeFormat: "pharmacy",
    verification: "provider_discovered",
    identityStatus: "canonical",
  },
  {
    id: "asda-official-existing",
    retailerId: "asda-uk",
    provider: "asda_official_directory",
    providerId: "official:1",
    name: "ASDA Official",
    postcode: "B1 1AA",
    latitude: 52.48,
    longitude: -1.89,
    storeFormat: "supermarket",
    verification: "official_retailer_branch",
    identityStatus: "canonical",
  },
];

const masterCsv = `Retailer,Canonical Retailer ID,Branch Name,Host Retailer,Store Relationship,Address,Town / City,County / Region,Postcode,Country,Latitude,Longitude,Store Format,Current Status,TCG Eligibility,TCG Evidence,Branch Identity Status,Pokémon Seller Status,Physical Stock Status,Stock Claim,Duplicate Key,Official / Dataset Source URL,Source Type,Source Checked Date,Source Freshness,Import Ready,Import Scope,Conflict Status,Notes
Tesco,tesco-uk,Tesco Extra Watford,,STANDALONE,Watford,Watford,,WD17 1AA,United Kingdom,51.656,-0.395,Superstore,OPEN_BASELINE,LIKELY_TCG_RETAILER,Dataset branch identity,SOURCE_VERIFIED,RETAILER_LIKELY_BRANCH_UNCONFIRMED,UNKNOWN,false,tesco-uk|WD171AA,https://example.test/geolytix,GEOLYTIX_RETAIL_POINTS,2026-09-01,GEOLYTIX_2026_Q3,YES,BRANCH_IDENTITY_ONLY,CLEAR,
The Entertainer,entertainer-uk,The Entertainer Brighton,,STANDALONE,Brighton,Brighton,,BN1 2TF,United Kingdom,50.822,-0.143,Toy store,OPEN,OFFICIAL_POKEMON_RETAILER,Official branch,SOURCE_VERIFIED,RETAILER_VERIFIED_BRANCH_UNCONFIRMED,UNKNOWN,false,entertainer-uk|BN12TF,https://example.test/entertainer,OFFICIAL_BRANCH_PAGE,2026-09-01,CURRENT_OFFICIAL,YES,BRANCH_IDENTITY_ONLY,CLEAR,
Tesco,tesco-uk,Tesco Conflict,,STANDALONE,London,London,,E1 8AL,United Kingdom,51.51,-0.08,Superstore,OPEN_BASELINE,LIKELY_TCG_RETAILER,Dataset branch identity,SOURCE_VERIFIED,RETAILER_LIKELY_BRANCH_UNCONFIRMED,UNKNOWN,false,tesco-uk|E18AL,https://example.test/conflict,GEOLYTIX_RETAIL_POINTS,2026-09-01,GEOLYTIX_2026_Q3,YES,BRANCH_IDENTITY_ONLY,CLEAR,
Tesco,tesco-uk,Tesco Nearby,,STANDALONE,London,London,,SW2 5RS,United Kingdom,51.4512,-0.1231,Superstore,OPEN_BASELINE,LIKELY_TCG_RETAILER,Dataset branch identity,SOURCE_VERIFIED,RETAILER_LIKELY_BRANCH_UNCONFIRMED,UNKNOWN,false,tesco-uk|SW25RS,https://example.test/nearby,GEOLYTIX_RETAIL_POINTS,2026-09-01,GEOLYTIX_2026_Q3,YES,BRANCH_IDENTITY_ONLY,CLEAR,
Tesco,tesco-uk,Unsafe Stock Row,,STANDALONE,London,London,,N1 1AA,United Kingdom,51.5,-0.1,Superstore,OPEN_BASELINE,LIKELY_TCG_RETAILER,Unsafe,SOURCE_VERIFIED,RETAILER_LIKELY_BRANCH_UNCONFIRMED,IN_STOCK,true,tesco-uk|N11AA,https://example.test/unsafe,GEOLYTIX_RETAIL_POINTS,2026-09-01,GEOLYTIX_2026_Q3,YES,BRANCH_IDENTITY_ONLY,CLEAR,
`;

test("evidence harvest independently reconciles exact matches without creating stock or Echo authority", () => {
  const before = structuredClone(legacyRows);
  const report = buildLocalRadarEvidenceHarvest({ legacyRows, masterCsvText: masterCsv });

  assert.equal(report.mode, "read_only_evidence_harvest_no_writes");
  assert.equal(report.policy.productionDatabaseTouched, false);
  assert.equal(report.policy.providerDiscoveryAloneCanonical, false);
  assert.equal(report.policy.echoAuthorityCreated, false);
  assert.equal(report.policy.stockStatus, "UNKNOWN");
  assert.equal(report.policy.stockClaim, false);

  assert.equal(report.counts.currentEligible, 1);
  assert.equal(report.counts.unresolvedDiscovery, 5);
  assert.equal(report.counts.masterSourceRows, 5);
  assert.equal(report.counts.safeMasterRows, 4);
  assert.equal(report.counts.exactOfficialRecovery, 1);
  assert.equal(report.counts.exactIndependentDatasetRecovery, 1);
  assert.equal(report.counts.autoRecoverable, 2);
  assert.equal(report.counts.exactConflict, 1);
  assert.equal(report.counts.nearbyReview, 1);
  assert.equal(report.counts.unmatched, 1);
  assert.equal(report.counts.predictedEligibleAfterEvidence, 3);

  const dataset = report.recovery.exactIndependentDatasetRecovery[0];
  assert.equal(dataset.location.id, "tesco-dataset-match");
  assert.equal(dataset.proposedVerification, "independently_reconciled");
  assert.equal(dataset.proposedEvidenceSourceCountFloor, 2);
  assert.equal(dataset.stockStatus, "UNKNOWN");
  assert.equal(dataset.stockClaim, false);
  assert.equal(dataset.echoAuthority, false);

  const official = report.recovery.exactOfficialRecovery[0];
  assert.equal(official.location.id, "entertainer-official-match");
  assert.equal(official.proposedVerification, "official_retailer_branch");
  assert.equal(official.echoAuthority, false);

  assert.equal(report.recovery.exactConflict[0].location.id, "tesco-coordinate-conflict");
  assert.equal(report.recovery.nearbyReview[0].location.id, "tesco-nearby-review");
  assert.ok(!report.recovery.exactOfficialRecovery.some((row) => row.location.id === "tesco-pharmacy"));
  assert.ok(!report.recovery.exactIndependentDatasetRecovery.some((row) => row.location.id === "tesco-pharmacy"));

  assert.deepEqual(legacyRows, before, "audit must not mutate raw stock/history/location rows");
  assert.deepEqual(legacyRows[0].openingDetails.lifecycleHistory, ["echo:historical"]);
});
