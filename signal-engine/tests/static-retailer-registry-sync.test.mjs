import test from "node:test";
import assert from "node:assert/strict";
import { ensureStaticRetailersInRegistry, staticRetailerToRegistryCandidate } from "../src/retailers/static-registry-sync.mjs";

test("static retailer mapping preserves canonical retailer identity and regex runtime", () => {
  const mapped = staticRetailerToRegistryCandidate({
    id: "smyths-uk",
    name: "Smyths Toys UK",
    enabled: true,
    baseUrl: "https://www.smythstoys.com/uk/en-gb/",
    retailerClass: "national",
    adapterType: "generic_html",
    verification: "pending",
    rrpAuthority: "retailer_reference",
    tcgs: ["pokemon"],
    catalogueUrls: ["https://www.smythstoys.com/uk/en-gb/pokemon"],
    productUrlPattern: /\/p\/\d+/i,
    skuPattern: /\/p\/(\d+)/i,
    include: /pokemon|tcg/i,
    maxPages: 4,
    delayMs: 2200,
  });
  assert.equal(mapped.id, "smyths-uk");
  assert.equal(mapped.state, "monitored");
  assert.equal(mapped.catalogue.runtime.productUrlPattern, "\\/p\\/\\d+");
  assert.equal(mapped.catalogue.runtime.skuPattern, "\\/p\\/(\\d+)");
  assert.equal(mapped.catalogue.runtime.include, "pokemon|tcg");
});

test("registry seeding inserts only missing launch retailers and never overwrites existing decisions", async () => {
  const upserts = [];
  const registry = {
    async list() { return [{ id: "tesco-uk", state: "paused" }]; },
    async upsert(candidate) { upserts.push(candidate); return candidate; },
  };
  const result = await ensureStaticRetailersInRegistry({
    registry,
    staticRetailers: [
      { id: "tesco-uk", name: "Tesco", baseUrl: "https://www.tesco.com/", enabled: true },
      { id: "argos-uk", name: "Argos", baseUrl: "https://www.argos.co.uk/", enabled: true },
      { id: "entertainer-uk", name: "The Entertainer", baseUrl: "https://www.thetoyshop.com/", enabled: false },
    ],
  });
  assert.deepEqual(result.inserted.sort(), ["argos-uk", "entertainer-uk"]);
  assert.equal(upserts.length, 2);
  assert.equal(upserts.some((item) => item.id === "tesco-uk"), false, "existing registry state must not be silently overwritten");
  assert.equal(upserts.find((item) => item.id === "entertainer-uk").state, "paused");
});
