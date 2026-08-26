import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnownChainOverpassQuery,
  normalizeOverpassBranchElements,
  runOsmRetailerBranchSync,
} from "../src/encounters/osm-retailer-branch-sync.mjs";

const ELEMENTS = [
  {
    type: "node", id: 1, lat: 51.75, lon: -0.2,
    tags: { name: "Tesco Extra", brand: "Tesco", shop: "supermarket", "addr:postcode": "AL9 5AB", "addr:street": "Great North Road" },
  },
  {
    type: "node", id: 2, lat: 51.76, lon: -0.21,
    tags: { name: "Tesco Express", brand: "Tesco", shop: "convenience", "addr:postcode": "AL9 5CD" },
  },
  {
    type: "way", id: 3, center: { lat: 51.77, lon: -0.22 },
    tags: { name: "Argos in Sainsbury's", brand: "Argos", shop: "catalogue", "addr:postcode": "EN8 9AA" },
  },
  {
    type: "node", id: 4, lat: 51.78, lon: -0.23,
    tags: { name: "The Entertainer", brand: "The Entertainer", shop: "toys", "addr:postcode": "EN8 9BB" },
  },
  {
    type: "node", id: 5, lat: 51.79, lon: -0.24,
    tags: { name: "Smyths Toys Superstores", brand: "Smyths Toys Superstores", shop: "toys", "addr:postcode": "EN8 9CC" },
  },
  {
    type: "node", id: 6, lat: 51.8, lon: -0.25,
    tags: { name: "Sainsbury's", brand: "Sainsbury's", shop: "supermarket", "addr:postcode": "EN8 9DD" },
  },
  {
    type: "node", id: 7, lat: 51.81, lon: -0.26,
    tags: { name: "Argos", brand: "Argos", shop: "catalogue", disused: "yes", "addr:postcode": "EN8 9EE" },
  },
];

function overpassResponse(elements = ELEMENTS, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return { elements }; },
  };
}

test("Overpass query is read-only and scoped to already-canonical physical chains", () => {
  const query = buildKnownChainOverpassQuery();
  assert.match(query, /ISO3166-1/);
  assert.match(query, /Tesco/);
  assert.match(query, /Argos/);
  assert.match(query, /The Entertainer/);
  assert.match(query, /Smyths/);
  assert.doesNotMatch(query, /Sainsbury/);
  assert.doesNotMatch(query, /delete|update|insert/i);
});

test("geographic fallback maps supported chains, excludes Tesco Express and unregistered chains, and never creates stock truth", () => {
  const normalized = normalizeOverpassBranchElements(ELEMENTS, { now: Date.parse("2026-08-26T14:00:00Z") });
  assert.equal(normalized.locations.length, 4);
  assert.deepEqual(new Set(normalized.locations.map((row) => row.retailerId)), new Set(["tesco-uk", "argos-uk", "entertainer-uk", "smyths-uk"]));
  assert.equal(normalized.locations.some((row) => /express/i.test(row.name)), false);
  assert.equal(normalized.locations.some((row) => row.retailerId === "sainsburys-uk"), false);
  for (const row of normalized.locations) {
    assert.equal(row.provider, "openstreetmap");
    assert.equal(row.verification, "provider_discovered");
    assert.equal(row.openingDetails.sourceAttribution, "© OpenStreetMap contributors");
    assert.equal("stockStatus" in row, false);
    assert.equal("lifecycleState" in row, false);
  }
});

test("OSM sync persists only new provider IDs and exposes attribution and retailer counts", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return [{ provider: "openstreetmap", providerId: "node/1" }]; },
    async upsertRetailerLocations(rows) { saved.push(...rows); return { saved: rows.length }; },
  };
  const result = await runOsmRetailerBranchSync({
    store,
    fetchImpl: async () => overpassResponse(),
    saveLimit: 10,
    now: Date.parse("2026-08-26T14:00:00Z"),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.accepted, 4);
  assert.equal(result.alreadyKnown, 1);
  assert.equal(result.saved, 3);
  assert.equal(saved.some((row) => row.providerId === "node/1"), false);
  assert.equal(result.countsByRetailer["tesco-uk"], 1);
  assert.equal(result.countsByRetailer["argos-uk"], 1);
  assert.equal(result.attribution, "© OpenStreetMap contributors");
  assert.match(result.truthRule, /never establishes Pokémon stock or Local Manifested/i);
});

test("OSM sync reports deferred branches when a cycle save cap is reached", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations(rows) { saved.push(...rows); return { saved: rows.length }; },
  };
  const result = await runOsmRetailerBranchSync({
    store,
    fetchImpl: async () => overpassResponse(),
    saveLimit: 2,
    now: Date.parse("2026-08-26T14:00:00Z"),
  });
  assert.equal(result.accepted, 4);
  assert.equal(result.attempted, 2);
  assert.equal(result.deferred, 2);
  assert.equal(result.saved, 2);
  assert.equal(saved.length, 2);
});

test("OSM provider failure is fail-closed and does not synthesize branches", async () => {
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations() { throw new Error("must not persist"); },
  };
  const result = await runOsmRetailerBranchSync({ store, fetchImpl: async () => overpassResponse([], 429) });
  assert.equal(result.status, "unavailable");
  assert.equal(result.saved, 0);
  assert.match(result.error, /429/);
});
