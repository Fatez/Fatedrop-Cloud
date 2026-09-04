import assert from "node:assert/strict";
import test from "node:test";

import {
  CURATED_MANUAL_RETAILER_BRANCH_SEEDS,
  CURATED_MANUAL_RETAILER_REGISTRY_SEEDS,
} from "../src/encounters/curated-retailer-manual-branch-seeds.mjs";

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

test("final curated physical retailer database has the expected unique branch coverage", () => {
  assert.equal(CURATED_MANUAL_RETAILER_BRANCH_SEEDS.length, 216);

  const expected = new Map([
    ["smyths-uk", 15],
    ["hamleys-uk", 11],
    ["entertainer-uk", 35],
    ["game-uk", 30],
    ["tesco-uk", 45],
    ["asda-uk", 45],
    ["bm-stores-uk", 35],
  ]);
  const counts = new Map();
  const identities = new Set();

  for (const seed of CURATED_MANUAL_RETAILER_BRANCH_SEEDS) {
    counts.set(seed.retailerId, Number(counts.get(seed.retailerId) || 0) + 1);
    const key = `${seed.retailerId}|${postcodeKey(seed.postcode)}`;
    assert.equal(identities.has(key), false, `duplicate physical branch identity: ${key}`);
    identities.add(key);

    assert.equal(seed.verification, "curated_branch");
    assert.deepEqual(seed.supportedTcgs, ["pokemon"]);
    assert.equal("stockStatus" in seed, false);
    assert.equal("stockClaim" in seed, false);
    assert.match(seed.notes, /stock remains unknown/i);
  }

  assert.deepEqual([...counts.entries()].sort(), [...expected.entries()].sort());
  assert.equal(identities.size, 216);
});

test("B&M is registered as physical-only and cannot become an online monitor from this import", () => {
  assert.equal(CURATED_MANUAL_RETAILER_REGISTRY_SEEDS.length, 1);
  const [bm] = CURATED_MANUAL_RETAILER_REGISTRY_SEEDS;
  assert.equal(bm.id, "bm-stores-uk");
  assert.equal(bm.websiteUrl, "https://www.bmstores.co.uk/");
  assert.equal(bm.adapterType, "manual");
  assert.equal(bm.state, "paused");
  assert.equal(bm.online, false);
  assert.equal(bm.physicalLocations, 35);
});
