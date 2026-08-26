import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverToyshopBranchUrls,
  parseOfficialBranchPage,
  runNationalBranchDirectorySync,
} from "../src/encounters/national-branch-directory-sync.mjs";

function response(body, { status = 200, json = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return String(body); },
    async json() { return json ? body : JSON.parse(String(body)); },
  };
}

const TOYSHOP_SITEMAP = `<?xml version="1.0"?><urlset>
  <url><loc>https://www.thetoyshop.com/store/welwyn-garden-city</loc></url>
  <url><loc>https://www.thetoyshop.com/store/tesco-hatfield-extra</loc></url>
  <url><loc>https://www.thetoyshop.com/pokemon</loc></url>
</urlset>`;

function storePage({ name, street, town, postcode, lat = null, lng = null, type = "Store" }) {
  const geo = lat == null ? "" : `,"geo":{"@type":"GeoCoordinates","latitude":${lat},"longitude":${lng}}`;
  return `<html><head><title>${name}</title><script type="application/ld+json">{"@type":"${type}","name":"${name}","address":{"@type":"PostalAddress","streetAddress":"${street}","addressLocality":"${town}","postalCode":"${postcode}"}${geo}}</script></head><body><h1>${name}</h1><p>${street}, ${town} ${postcode}</p></body></html>`;
}

function createFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === "https://www.thetoyshop.com/sitemap/media/Store-en-GBP") return response(TOYSHOP_SITEMAP);
    if (target === "https://www.thetoyshop.com/store/welwyn-garden-city") {
      return response(storePage({ name: "The Entertainer Welwyn Garden City", street: "Unit 53 Howard Centre", town: "Welwyn Garden City", postcode: "AL8 6HA", lat: 51.802, lng: -0.206 }));
    }
    if (target === "https://www.thetoyshop.com/store/tesco-hatfield-extra") {
      return response(storePage({ name: "Tesco Hatfield Extra", street: "Great North Road", town: "Hatfield", postcode: "AL9 5JY" }));
    }
    if (target === "https://storelocator.asda.com/directory") {
      return response('<a href="/east-of-england">East of England</a>');
    }
    if (target === "https://storelocator.asda.com/east-of-england") {
      return response('<a href="/east-of-england/welwyn">Welwyn</a>');
    }
    if (target === "https://storelocator.asda.com/east-of-england/welwyn") {
      return response('<a href="/east-of-england/welwyn/borough-road">ASDA Welwyn Superstore</a><a href="/east-of-england/welwyn/a1-express-petrol">ASDA Express Petrol</a>');
    }
    if (target === "https://storelocator.asda.com/east-of-england/welwyn/borough-road") {
      return response(storePage({ name: "ASDA Welwyn Superstore", street: "1 Borough Road", town: "Welwyn", postcode: "AL6 9AA", lat: 51.83, lng: -0.21, type: "Supermarket" }));
    }
    if (target === "https://storelocator.asda.com/east-of-england/welwyn/a1-express-petrol") {
      return response(storePage({ name: "ASDA A1 Express Petrol", street: "A1 Road", town: "Welwyn", postcode: "AL6 9AB", lat: 51.84, lng: -0.22, type: "GasStation" }));
    }
    if (target.startsWith("https://api.postcodes.io/postcodes/AL9%205JY")) {
      return response({ result: { latitude: 51.763, longitude: -0.224 } }, { json: true });
    }
    throw new Error(`Unexpected fetch ${target}`);
  };
  return { fetchImpl, calls };
}

test("official Toyshop sitemap classifies Entertainer stores and Tesco stockists separately", async () => {
  const { fetchImpl } = createFetch();
  const rows = await discoverToyshopBranchUrls({ fetchImpl });
  assert.deepEqual(rows.map((row) => [row.retailerId, row.provider, row.url]), [
    ["entertainer-uk", "entertainer_official_directory", "https://www.thetoyshop.com/store/welwyn-garden-city"],
    ["tesco-uk", "entertainer_official_stockist", "https://www.thetoyshop.com/store/tesco-hatfield-extra"],
  ]);
});

test("official branch page uses exact branch identity and postcode geocoding without creating stock truth", async () => {
  const { fetchImpl } = createFetch();
  const parsed = await parseOfficialBranchPage({
    url: "https://www.thetoyshop.com/store/tesco-hatfield-extra",
    retailerId: "tesco-uk",
    provider: "entertainer_official_stockist",
  }, { fetchImpl });
  assert.equal(parsed.location.retailerId, "tesco-uk");
  assert.equal(parsed.location.postcode, "AL9 5JY");
  assert.equal(parsed.location.latitude, 51.763);
  assert.equal(parsed.location.longitude, -0.224);
  assert.equal(parsed.location.verification, "official_retailer_branch");
  assert.equal("stockStatus" in parsed.location, false);
  assert.equal("lifecycleState" in parsed.location, false);
});

test("national branch sync saves easy-win official branches and excludes ASDA petrol-only formats", async () => {
  const { fetchImpl } = createFetch();
  const savedLocations = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations(rows) {
      savedLocations.push(...rows);
      return { saved: rows.length };
    },
  };
  const result = await runNationalBranchDirectorySync({ store, fetchImpl, branchFetchLimit: 20 });
  assert.equal(result.status, "ok");
  assert.equal(result.discovered, 4);
  assert.equal(result.accepted, 3);
  assert.equal(result.saved, 3);
  assert.equal(result.rejected, 1);
  assert.deepEqual(new Set(savedLocations.map((row) => row.retailerId)), new Set(["entertainer-uk", "tesco-uk", "asda-uk"]));
  assert.equal(savedLocations.some((row) => /express petrol/i.test(row.name)), false);
  assert.match(result.truthRule, /never establishes Pokémon stock or Local Manifested/i);
});

test("known branch provider IDs are skipped rather than re-fetched every cycle", async () => {
  const { fetchImpl, calls } = createFetch();
  const knownUrl = "https://www.thetoyshop.com/store/welwyn-garden-city";
  const store = {
    async listRetailerLocations() {
      return [{ provider: "entertainer_official_directory", providerId: knownUrl }];
    },
    async upsertRetailerLocations(rows) { return { saved: rows.length }; },
  };
  await runNationalBranchDirectorySync({ store, fetchImpl, branchFetchLimit: 20 });
  assert.equal(calls.filter((url) => url === knownUrl).length, 0);
});
