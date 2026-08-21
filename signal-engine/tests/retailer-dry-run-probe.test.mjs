import test from "node:test";
import assert from "node:assert/strict";
import { prepareCandidateDryRun } from "../src/retailers/dry-run-probe.mjs";
import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";

test("unapproved structured retailer requires explicit probe permission", () => {
  const candidate = normalizeRetailerCandidate({
    id: "probe-shop",
    name: "Probe Shop",
    websiteUrl: "https://shop.example/",
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.CANDIDATE,
    catalogue: { feedUrl: "https://shop.example/products.json?limit=250", feedApproved: false },
  });
  assert.throws(() => prepareCandidateDryRun(candidate), /explicit dry-run probe flag/i);
});

test("explicit structured probe approval is temporary and same-host only", () => {
  const candidate = normalizeRetailerCandidate({
    id: "probe-shop",
    name: "Probe Shop",
    websiteUrl: "https://www.shop.example/",
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.CANDIDATE,
    catalogue: { feedUrl: "https://shop.example/products.json?limit=250", feedApproved: false },
  });
  const prepared = prepareCandidateDryRun(candidate, { allowStructuredFeedProbe: true });
  assert.equal(prepared.catalogue.feedApproved, true);
  assert.equal(prepared.state, RETAILER_STATES.QUALIFYING);
  assert.equal(candidate.catalogue.feedApproved, false, "original discovery record must remain unapproved");

  const externalFeed = normalizeRetailerCandidate({
    ...candidate,
    catalogue: { feedUrl: "https://third-party.example/products.json", feedApproved: false },
  });
  assert.throws(
    () => prepareCandidateDryRun(externalFeed, { allowStructuredFeedProbe: true }),
    /must stay on the retailer website hostname/i,
  );
});
