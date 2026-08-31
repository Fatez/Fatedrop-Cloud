import assert from "node:assert/strict";
import test from "node:test";

import {
  authoritativeMarketClaims,
  explicitListingMarketClaims,
  resolveCanonicalMarket,
} from "../src/core/market-memory-policy.mjs";

test("language metadata never creates a market claim", () => {
  assert.deepEqual(explicitListingMarketClaims({ title: "Abyss Eye Booster Box", language: "ja" }), []);
  const claims = explicitListingMarketClaims({ title: "Abyss Eye Japanese Booster Box", language: "en" });
  const resolution = resolveCanonicalMarket({ listingClaims: claims });
  assert.equal(resolution.status, "candidate");
  assert.equal(resolution.marketCode, null);
  assert.equal(resolution.candidateMarketCode, "JP");
});

test("authoritative source-market MSRP verifies a candidate market", () => {
  const claims = authoritativeMarketClaims({
    rrpResolution: {
      resolved: true,
      sourceMarket: "JP",
      sourceUrl: "https://www.pokemon-card.com/products/example",
      authorityId: "jp-example",
    },
  });
  const resolution = resolveCanonicalMarket({
    listingClaims: explicitListingMarketClaims({ title: "Abyss Eye Japanese Booster Box" }),
    authoritativeClaims: claims,
  });
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.marketCode, "JP");
  assert.equal(resolution.confidence, 1);
});

test("verified memory is reused for an unmarked future listing", () => {
  const resolution = resolveCanonicalMarket({
    remembered: { marketCode: "JP", status: "verified", verificationMethod: "authoritative_market_msrp" },
    listingClaims: explicitListingMarketClaims({ title: "Abyss Eye Booster Box" }),
  });
  assert.equal(resolution.status, "reused");
  assert.equal(resolution.marketCode, "JP");
});

test("remembered, listing and authoritative conflicts fail closed", () => {
  const rememberedConflict = resolveCanonicalMarket({
    remembered: { marketCode: "JP", status: "verified" },
    listingClaims: explicitListingMarketClaims({ title: "Abyss Eye Korean Booster Box" }),
  });
  assert.equal(rememberedConflict.status, "conflict");
  assert.equal(rememberedConflict.marketCode, null);

  const authorityConflict = resolveCanonicalMarket({
    listingClaims: explicitListingMarketClaims({ title: "Abyss Eye Korean Booster Box" }),
    authoritativeClaims: authoritativeMarketClaims({
      evidence: [{ kind: "verified_source_market", value: "JP", sourceRole: "manufacturer" }],
    }),
  });
  assert.equal(authorityConflict.status, "conflict");
  assert.equal(authorityConflict.marketCode, null);
});

test("untrusted source-market evidence cannot verify memory", () => {
  assert.deepEqual(authoritativeMarketClaims({
    evidence: [{ kind: "verified_source_market", value: "KR", sourceRole: "retailer_guess" }],
  }), []);
});
