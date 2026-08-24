import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicRetailerDirectory } from "../src/retailers/public-directory.mjs";

test("public retailer directory exposes identity, presence and effective monitoring truth without adapter internals", () => {
  const [profile] = buildPublicRetailerDirectory({
    retailers: [{
      id: "indie-one",
      name: "Indie One",
      baseUrl: "https://indie.example/",
      retailerClass: "independent",
      verification: "verified",
      tcgs: ["pokemon", "magic"],
      online: true,
      physicalLocations: 2,
      adapterType: "shopify",
      catalogueUrls: ["https://indie.example/private-ish-catalogue-path"],
    }],
    healthRows: [{
      id: "indie-one",
      healthy: true,
      stale: false,
      baselineCompleted: true,
      productsSeen: 123,
      lastScanAt: 1000,
      lastSuccessAt: 999,
      lastError: "must not leak",
    }],
  });

  assert.equal(profile.websiteUrl, "https://indie.example/");
  assert.equal(profile.retailerClass, "independent");
  assert.deepEqual(profile.tcgs, ["pokemon", "magic"]);
  assert.equal(profile.online, true);
  assert.equal(profile.physicalStores, true);
  assert.equal(profile.physicalLocations, 2);
  assert.equal(profile.monitoring.healthy, true);
  assert.equal(profile.monitoring.productsSeen, 123);
  assert.equal("adapterType" in profile, false);
  assert.equal("catalogueUrls" in profile, false);
  assert.equal("lastError" in profile.monitoring, false);
});

test("directory does not infer online-only when physical presence is unknown", () => {
  const [profile] = buildPublicRetailerDirectory({ retailers: [{
    id: "unverified-presence",
    name: "Presence Unknown",
    baseUrl: "https://unknown.example",
    retailerClass: "independent",
    online: true,
  }] });
  assert.equal(profile.online, true);
  assert.equal(profile.physicalStores, null);
  assert.equal(profile.physicalLocations, null);
});

test("known launch retailers can expose physical presence without inventing store counts", () => {
  const profiles = buildPublicRetailerDirectory({ retailers: [
    { id: "chaos-cards", name: "Chaos Cards", baseUrl: "https://www.chaoscards.co.uk", retailerClass: "specialist" },
    { id: "magic-madhouse", name: "Magic Madhouse", baseUrl: "https://magicmadhouse.co.uk", retailerClass: "specialist" },
  ] });
  const chaos = profiles.find((profile) => profile.id === "chaos-cards");
  const magic = profiles.find((profile) => profile.id === "magic-madhouse");
  assert.equal(chaos?.physicalStores, true);
  assert.equal(chaos?.physicalLocations, null);
  assert.equal(magic?.physicalStores, false);
  assert.equal(magic?.physicalLocations, null);
});

test("directory prefers independents and specialists ahead of national retailers", () => {
  const profiles = buildPublicRetailerDirectory({ retailers: [
    { id: "national", name: "National", baseUrl: "https://national.example", retailerClass: "national" },
    { id: "specialist", name: "Specialist", baseUrl: "https://specialist.example", retailerClass: "specialist" },
    { id: "indie", name: "Indie", baseUrl: "https://indie.example", retailerClass: "independent" },
  ] });
  assert.deepEqual(profiles.map((profile) => profile.id), ["indie", "specialist", "national"]);
});
