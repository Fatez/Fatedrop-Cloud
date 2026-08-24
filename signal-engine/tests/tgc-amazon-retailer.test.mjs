import test from "node:test";
import assert from "node:assert/strict";
import { resolveRetailerDelivery } from "../src/core/delivery-policies.mjs";
import {
  amazonUkIntegrationReadiness,
  buildAdditionalLaunchRetailers,
} from "../src/retailers/additional-launch-retailers.mjs";
import { ADAPTER_TYPES, RRP_AUTHORITY } from "../src/retailers/registry.mjs";

test("TGC Collectables is a live Shopify launch retailer with a bounded Pokemon feed", () => {
  const retailers = buildAdditionalLaunchRetailers({
    tgcEnabled: true,
    amazonRequested: false,
    amazonCredentialsConfigured: false,
  });
  assert.equal(retailers.length, 1);
  const tgc = retailers[0];
  assert.equal(tgc.id, "tgc-collectables");
  assert.equal(tgc.name, "TGC Collectables");
  assert.equal(tgc.adapterType, ADAPTER_TYPES.SHOPIFY);
  assert.equal(tgc.catalogue.feedApproved, true);
  assert.equal(tgc.catalogue.feedUrl, "https://collect.thegamecollection.net/collections/pokemon/products.json?limit=250");
  assert.equal(tgc.catalogue.runtime.maxPages, 4);
  assert.equal(tgc.rrpAuthority, RRP_AUTHORITY.RETAILER_REFERENCE);
  assert.equal(tgc.officialRrpSource, false);
  assert.equal(tgc.include.test("Temporal Forces - 3 Pack Blister"), true);
  assert.equal(tgc.exclude.test("Pokemon single card PSA graded"), true);
});

test("TGC delivery is free only when the verified £20 threshold is met", () => {
  const atThreshold = resolveRetailerDelivery({ retailerId: "tgc-collectables", subtotalPence: 2000 });
  assert.equal(atThreshold.known, true);
  assert.equal(atThreshold.postagePence, 0);
  assert.equal(atThreshold.freeShippingThresholdPence, 2000);

  const belowThreshold = resolveRetailerDelivery({ retailerId: "tgc-collectables", subtotalPence: 1999 });
  assert.equal(belowThreshold.known, false);
  assert.equal(belowThreshold.postagePence, null);
});

test("Amazon UK cannot enter the normal persistent monitoring runtime until its retention guard is satisfied", () => {
  const readiness = amazonUkIntegrationReadiness({
    requested: true,
    credentialsConfigured: true,
    storagePolicyCompatible: false,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "amazon_content_retention_guard");

  const retailers = buildAdditionalLaunchRetailers({
    tgcEnabled: false,
    amazonRequested: true,
    amazonCredentialsConfigured: true,
    amazonStoragePolicyCompatible: false,
  });
  assert.deepEqual(retailers, []);
});

test("Amazon UK config is marketplace-labelled and never an RRP authority once the explicit storage gate is satisfied", () => {
  const retailers = buildAdditionalLaunchRetailers({
    tgcEnabled: false,
    amazonRequested: true,
    amazonCredentialsConfigured: true,
    amazonStoragePolicyCompatible: true,
    amazonMarketplace: "www.amazon.co.uk",
  });
  assert.equal(retailers.length, 1);
  const amazon = retailers[0];
  assert.equal(amazon.id, "amazon-uk");
  assert.equal(amazon.name, "Amazon UK Marketplace");
  assert.equal(amazon.adapterType, ADAPTER_TYPES.STRUCTURED_FEED);
  assert.equal(amazon.rrpAuthority, RRP_AUTHORITY.NONE);
  assert.equal(amazon.officialRrpSource, false);
  assert.equal(amazon.catalogue.marketplace, "www.amazon.co.uk");
});
