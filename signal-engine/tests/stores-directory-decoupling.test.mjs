import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicRetailerDirectory, selectPublicDirectoryRetailers } from "../src/retailers/public-directory.mjs";

test("verified indie can appear in Stores without becoming an alert monitor", () => {
  const runtimeRetailers = [{
    id: "live-monitor",
    name: "Live Monitor",
    baseUrl: "https://live.example",
    retailerClass: "specialist",
    verification: "pending",
    tcg: "pokemon",
  }];
  const registryRetailers = [{
    id: "cob-and-pip",
    name: "Cob & Pip",
    websiteUrl: "https://cobandpip.co.uk/",
    retailerClass: "independent",
    verification: "verified",
    state: "candidate",
    tcgs: ["pokemon"],
    online: true,
    physicalLocations: 0,
  }, {
    id: "wishlist-collectables",
    name: "Wishlist Collectables",
    websiteUrl: "https://www.wishlistcollectables.co.uk/",
    retailerClass: "independent",
    verification: "verified",
    state: "candidate",
    tcgs: ["pokemon"],
    online: true,
    physicalLocations: 1,
  }];

  const directory = buildPublicRetailerDirectory({ runtimeRetailers, retailers: runtimeRetailers, registryRetailers });
  const cob = directory.find((retailer) => retailer.id === "cob-and-pip");
  const wishlist = directory.find((retailer) => retailer.id === "wishlist-collectables");
  const live = directory.find((retailer) => retailer.id === "live-monitor");

  assert.ok(cob);
  assert.equal(cob.retailerClass, "independent");
  assert.equal(cob.verification, "verified");
  assert.equal(cob.monitoring.configured, false);
  assert.equal(cob.physicalStores, null);

  assert.ok(wishlist);
  assert.equal(wishlist.monitoring.configured, false);
  assert.equal(wishlist.physicalStores, true);
  assert.equal(wishlist.physicalLocations, 1);

  assert.ok(live);
  assert.equal(live.monitoring.configured, true);
});

test("unverified discovery candidates and rejected retailers stay out of public Stores", () => {
  const selected = selectPublicDirectoryRetailers({
    runtimeRetailers: [],
    registryRetailers: [{
      id: "unverified-candidate",
      name: "Unverified Candidate",
      websiteUrl: "https://candidate.example",
      verification: "pending",
      state: "candidate",
    }, {
      id: "rejected-retailer",
      name: "Rejected Retailer",
      websiteUrl: "https://rejected.example",
      verification: "verified",
      state: "rejected",
    }, {
      id: "verified-indie",
      name: "Verified Indie",
      websiteUrl: "https://verified.example",
      retailerClass: "independent",
      verification: "verified",
      state: "candidate",
    }],
  });

  assert.deepEqual(selected.map((retailer) => retailer.id), ["verified-indie"]);
});

test("runtime retailer remains public while formal verification is pending", () => {
  const selected = selectPublicDirectoryRetailers({
    runtimeRetailers: [{ id: "runtime-pending", name: "Runtime Pending", baseUrl: "https://runtime.example", verification: "pending" }],
    registryRetailers: [{ id: "runtime-pending", name: "Runtime Pending", websiteUrl: "https://runtime.example", verification: "pending", state: "monitored", retailerClass: "specialist" }],
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "runtime-pending");
  assert.equal(selected[0].retailerClass, "specialist");
});
