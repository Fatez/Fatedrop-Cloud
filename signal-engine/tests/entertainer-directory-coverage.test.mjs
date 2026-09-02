import assert from "node:assert/strict";
import test from "node:test";

import { listCanonicalRetailerLocations } from "../src/encounters/canonical-retailer-locations.mjs";
import { discoverToyshopBranchUrls } from "../src/encounters/national-branch-directory-sync.mjs";

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return String(body); },
  };
}

function storePage(index, total) {
  const next = index < total ? `<a href="/store/store-${index + 1}">Next store</a>` : "";
  return `<html><head><script type="application/ld+json">{"@type":"Store","name":"The Entertainer Store ${index}","address":{"@type":"PostalAddress","streetAddress":"${index} High Street","addressLocality":"Town ${index}","postalCode":"AA1 1AA"},"geo":{"@type":"GeoCoordinates","latitude":51.${String(index).padStart(3, "0")},"longitude":-1}}</script></head><body><h1>The Entertainer Store ${index}</h1>${next}</body></html>`;
}

test("official Entertainer fallback discovery reaches branches beyond the old 120-page ceiling", async () => {
  const total = 150;
  let storePageCalls = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target === "https://www.thetoyshop.com/sitemap/media/Store-en-GBP") {
      return response("unavailable", { status: 503 });
    }
    const match = new URL(target).pathname.match(/^\/store\/store-(\d+)$/);
    if (!match) throw new Error(`Unexpected fetch ${target}`);
    const index = Number(match[1]);
    storePageCalls += 1;
    return response(storePage(index, total));
  };

  const rows = await discoverToyshopBranchUrls({
    fetchImpl,
    fallbackSeeds: ["https://www.thetoyshop.com/store/store-1"],
  });

  assert.equal(rows.length, total);
  assert.equal(storePageCalls, total);
  assert.equal(rows.some((row) => row.url === "https://www.thetoyshop.com/store/store-150"), true);
  assert.equal(rows.every((row) => row.retailerId === "entertainer-uk"), true);
});

test("existing curated and new official Entertainer identities render as one canonical Radar branch", async () => {
  const shared = {
    retailerId: "entertainer-uk",
    name: "The Entertainer York",
    address: "Example Centre, York",
    postcode: "YO1 9WY",
    latitude: 53.9599,
    longitude: -1.0873,
    storeFormat: "toy_store",
    operationalStatus: "open",
    tcgSellerStatus: "verified",
    identityStatus: "canonical",
    updatedAt: 1788332400,
  };
  const curated = {
    ...shared,
    id: "loc_entertainer_york_curated",
    provider: "fatedrop_curated_directory",
    providerId: "entertainer-york",
    verification: "curated",
  };
  const official = {
    ...shared,
    id: "loc_entertainer_york_official",
    provider: "entertainer_official_directory",
    providerId: "https://www.thetoyshop.com/store/york",
    verification: "official_retailer_branch",
    openingDetails: {
      sourceType: "official_retailer_branch_page",
      sourceUrl: "https://www.thetoyshop.com/store/york",
    },
  };
  const store = {
    async listRetailerLocations() { return [curated, official]; },
  };

  const rows = await listCanonicalRetailerLocations(store, { retailerIds: ["entertainer-uk"] });

  assert.equal(rows.length, 1, "one physical Entertainer branch must produce one public Radar location");
  assert.equal(rows[0].id, official.id, "stronger official identity must win duplicate reconciliation");
  assert.equal(rows[0].provider, "entertainer_official_directory");
});
