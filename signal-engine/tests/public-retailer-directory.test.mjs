import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicRetailerDirectory } from "../src/retailers/public-directory.mjs";

test("public retailer directory exposes identity and effective monitoring truth without adapter internals", () => {
  const [profile] = buildPublicRetailerDirectory({
    retailers: [{
      id: "indie-one",
      name: "Indie One",
      baseUrl: "https://indie.example/",
      retailerClass: "independent",
      verification: "verified",
      tcgs: ["pokemon", "magic"],
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
  assert.equal(profile.monitoring.healthy, true);
  assert.equal(profile.monitoring.productsSeen, 123);
  assert.equal("adapterType" in profile, false);
  assert.equal("catalogueUrls" in profile, false);
  assert.equal("lastError" in profile.monitoring, false);
});

test("directory prefers independents and specialists ahead of national retailers", () => {
  const profiles = buildPublicRetailerDirectory({ retailers: [
    { id: "national", name: "National", baseUrl: "https://national.example", retailerClass: "national" },
    { id: "specialist", name: "Specialist", baseUrl: "https://specialist.example", retailerClass: "specialist" },
    { id: "indie", name: "Indie", baseUrl: "https://indie.example", retailerClass: "independent" },
  ] });
  assert.deepEqual(profiles.map((profile) => profile.id), ["indie", "specialist", "national"]);
});
