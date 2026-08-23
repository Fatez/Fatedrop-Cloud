import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapAsmodeeRrp } from "../src/rrp/asmodee-bootstrap.mjs";

function storeWithAuthority({ count, latestObservedAt = null }) {
  return {
    async pool() {
      return {
        async query(sql) {
          assert.match(sql, /rrp_source='asmodee-uk'/);
          assert.match(sql, /max\(rrp_observed_at\)/);
          return { rows: [{ count, latest_observed_at: latestObservedAt }] };
        },
      };
    },
  };
}

test("Asmodee authority sync runs when production has no Asmodee RRP", async () => {
  let calls = 0;
  const outcome = await bootstrapAsmodeeRrp({
    store: storeWithAuthority({ count: 0 }),
    databaseUrl: "postgres://example",
    now: 2_000_000,
    syncFn: async ({ databaseUrl, now }) => {
      calls += 1;
      assert.equal(databaseUrl, "postgres://example");
      assert.equal(now, 2_000_000);
      return { source: "asmodee-uk", matched: 4 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.refreshReason, "not_bootstrapped");
  assert.equal(outcome.result.matched, 4);
});

test("recent authoritative Asmodee evidence does not trigger another crawl", async () => {
  let calls = 0;
  const outcome = await bootstrapAsmodeeRrp({
    store: storeWithAuthority({ count: 67, latestObservedAt: 1_999_000 }),
    databaseUrl: "postgres://example",
    now: 2_000_000,
    maxAgeSeconds: 86_400,
    syncFn: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(outcome, {
    skipped: true,
    reason: "authoritative_evidence_fresh",
    existing: 67,
    latestObservedAt: 1_999_000,
    ageSeconds: 1_000,
  });
});

test("stale authoritative evidence is refreshed instead of remaining permanently bootstrapped", async () => {
  let calls = 0;
  const outcome = await bootstrapAsmodeeRrp({
    store: storeWithAuthority({ count: 67, latestObservedAt: 1_800_000 }),
    databaseUrl: "postgres://example",
    now: 2_000_000,
    maxAgeSeconds: 86_400,
    syncFn: async ({ now }) => {
      calls += 1;
      assert.equal(now, 2_000_000);
      return { source: "asmodee-uk", matched: 12 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.refreshReason, "authoritative_evidence_stale");
  assert.equal(outcome.previous.existing, 67);
  assert.equal(outcome.previous.latestObservedAt, 1_800_000);
  assert.equal(outcome.previous.ageSeconds, 200_000);
  assert.equal(outcome.result.matched, 12);
});

test("missing observed timestamp fails safe toward refreshing evidence", async () => {
  let calls = 0;
  const outcome = await bootstrapAsmodeeRrp({
    store: storeWithAuthority({ count: 3, latestObservedAt: null }),
    databaseUrl: "postgres://example",
    now: 2_000_000,
    syncFn: async () => { calls += 1; return { matched: 1 }; },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.refreshReason, "authoritative_evidence_stale");
});

test("Asmodee authority refresh stays inert without a persistent production database", async () => {
  assert.deepEqual(await bootstrapAsmodeeRrp({ store: {}, databaseUrl: "" }), { skipped: true, reason: "database_not_configured" });
  assert.deepEqual(await bootstrapAsmodeeRrp({ store: {}, databaseUrl: "postgres://example" }), { skipped: true, reason: "persistent_store_not_available" });
});
