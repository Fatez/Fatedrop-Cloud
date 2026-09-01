import test from "node:test";
import assert from "node:assert/strict";
import { ensureDiscoveryCandidatesInRegistry } from "../src/retailers/discovery-candidate-sync.mjs";
import { RETAILER_STATES, RRP_AUTHORITY, VERIFICATION_STATES } from "../src/retailers/registry.mjs";

function lead(overrides = {}) {
  return {
    id: "new-shop",
    name: "New Shop",
    websiteUrl: "https://new-shop.co.uk/",
    state: RETAILER_STATES.CANDIDATE,
    verification: VERIFICATION_STATES.UNVERIFIED,
    rrpAuthority: RRP_AUTHORITY.NONE,
    tcgs: [],
    catalogue: { urls: ["https://new-shop.co.uk/"], feedApproved: false },
    discovery: { source: "test", discoveredAt: "2026-09-01T00:00:00.000Z", evidence: [] },
    ...overrides,
  };
}

function fakeRegistry(existing = []) {
  const writes = [];
  return {
    writes,
    async list() { return existing; },
    async upsert(candidate) { writes.push(candidate); return candidate; },
  };
}

test("candidate startup sync is insert-only and never downgrades an existing monitored retailer", async () => {
  const registry = fakeRegistry([{
    id: "new-shop",
    hostname: "new-shop.co.uk",
    state: RETAILER_STATES.MONITORED,
    verification: VERIFICATION_STATES.VERIFIED,
  }]);

  const result = await ensureDiscoveryCandidatesInRegistry({ registry, candidates: [lead()] });

  assert.equal(result.insertedCount, 0);
  assert.equal(result.skippedExistingCount, 1);
  assert.deepEqual(result.skippedExisting, ["new-shop"]);
  assert.equal(registry.writes.length, 0);
});

test("candidate startup sync deduplicates by hostname as well as id", async () => {
  const registry = fakeRegistry([{
    id: "canonical-existing-id",
    hostname: "new-shop.co.uk",
    state: RETAILER_STATES.QUALIFYING,
    verification: VERIFICATION_STATES.UNVERIFIED,
  }]);

  const result = await ensureDiscoveryCandidatesInRegistry({ registry, candidates: [lead()] });

  assert.equal(result.insertedCount, 0);
  assert.equal(result.skippedExistingCount, 1);
  assert.equal(registry.writes.length, 0);
});

test("candidate startup sync inserts only genuinely missing candidates", async () => {
  const registry = fakeRegistry([]);
  const first = lead();
  const sameHostnameDifferentId = lead({ id: "duplicate-domain", name: "Duplicate Domain" });
  const second = lead({ id: "second-shop", name: "Second Shop", websiteUrl: "https://second-shop.co.uk/", catalogue: { urls: ["https://second-shop.co.uk/"], feedApproved: false } });

  const result = await ensureDiscoveryCandidatesInRegistry({ registry, candidates: [first, sameHostnameDifferentId, second] });

  assert.equal(result.insertedCount, 2);
  assert.deepEqual(result.inserted, ["new-shop", "second-shop"]);
  assert.equal(result.skippedExistingCount, 1);
  assert.deepEqual(result.skippedExisting, ["duplicate-domain"]);
  assert.equal(registry.writes.length, 2);
  assert.ok(registry.writes.every((candidate) => candidate.state === RETAILER_STATES.CANDIDATE));
  assert.ok(registry.writes.every((candidate) => candidate.verification === VERIFICATION_STATES.UNVERIFIED));
  assert.ok(registry.writes.every((candidate) => candidate.catalogue.feedApproved === false));
});

test("candidate startup sync fails closed on promoted state, verification or approved feed", async () => {
  const cases = [
    lead({ state: RETAILER_STATES.MONITORED }),
    lead({ verification: VERIFICATION_STATES.VERIFIED }),
    lead({ catalogue: { urls: ["https://new-shop.co.uk/"], feedApproved: true } }),
  ];

  for (const candidate of cases) {
    const registry = fakeRegistry([]);
    await assert.rejects(() => ensureDiscoveryCandidatesInRegistry({ registry, candidates: [candidate] }));
    assert.equal(registry.writes.length, 0);
  }
});
