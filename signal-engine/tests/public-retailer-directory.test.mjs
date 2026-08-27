import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicRetailerDirectory, buildPublicRetailerProfile } from "../src/retailers/public-directory.mjs";

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
  assert.equal(profile.logoUrl, null);
  assert.equal(profile.description, null);
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

test("canonical branch counts override weaker runtime physical-presence metadata", () => {
  const [profile] = buildPublicRetailerDirectory({
    retailers: [{
      id: "physical-indie",
      name: "Physical Indie",
      baseUrl: "https://physical.example",
      retailerClass: "independent",
      online: true,
      physicalStores: false,
      physicalLocations: 0,
    }],
    locationCounts: new Map([["physical-indie", 2]]),
  });
  assert.equal(profile.online, true);
  assert.equal(profile.physicalStores, true);
  assert.equal(profile.physicalLocations, 2);
  assert.equal("stockStatus" in profile, false);
});

test("directory is alphabetical and does not rank retailer classes", () => {
  const profiles = buildPublicRetailerDirectory({ retailers: [
    { id: "national", name: "Zulu National", baseUrl: "https://national.example", retailerClass: "national" },
    { id: "specialist", name: "Beta Specialist", baseUrl: "https://specialist.example", retailerClass: "specialist" },
    { id: "indie", name: "Alpha Indie", baseUrl: "https://indie.example", retailerClass: "independent" },
  ] });
  assert.deepEqual(profiles.map((profile) => profile.id), ["indie", "specialist", "national"]);
});

test("public retailer profile exposes canonical branch identity without branch stock claims or provider internals", () => {
  const profile = buildPublicRetailerProfile({
    retailer: {
      id: "indie-one",
      name: "Indie One",
      baseUrl: "https://indie.example",
      logoUrl: "https://indie.example/logo.png",
      publicDescription: "A local TCG specialist.",
      retailerClass: "independent",
      tcgs: ["pokemon", "one_piece"],
      online: true,
    },
    health: { id: "indie-one", healthy: true, stale: false },
    locations: [{
      id: "branch-1",
      retailerId: "indie-one",
      provider: "google_places",
      providerId: "private-provider-key",
      name: "Indie One Hertford",
      address: "1 Example Street, Hertford",
      postcode: "SG13 7AA",
      latitude: 51.79,
      longitude: -0.08,
      website: "https://indie.example/hertford",
      phone: "01234 567890",
      openingDetails: { sourceAttribution: "internal provider detail" },
      verification: "provider_discovered",
    }],
  });

  assert.equal(profile.logoUrl, "https://indie.example/logo.png");
  assert.equal(profile.description, "A local TCG specialist.");
  assert.equal(profile.physicalStores, true);
  assert.equal(profile.physicalLocations, 1);
  assert.equal(profile.locations.length, 1);
  assert.deepEqual(profile.locations[0], {
    id: "branch-1",
    retailerId: "indie-one",
    name: "Indie One Hertford",
    address: "1 Example Street, Hertford",
    postcode: "SG13 7AA",
    latitude: 51.79,
    longitude: -0.08,
    websiteUrl: "https://indie.example/hertford",
    phone: "01234 567890",
    verification: "provider_discovered",
  });
  assert.equal("provider" in profile.locations[0], false);
  assert.equal("providerId" in profile.locations[0], false);
  assert.equal("openingDetails" in profile.locations[0], false);
  assert.equal("stockStatus" in profile.locations[0], false);
});
