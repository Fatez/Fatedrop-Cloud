import test from "node:test";
import assert from "node:assert/strict";
import {
  diffRetailerIntelligenceSnapshots,
  normalizeRetailerIntelligenceSnapshot,
  reconcileRetailerIntelligenceSurfaceSnapshot,
} from "../src/encounters/retailer-intelligence-surfaces.mjs";

const NOW = Date.parse("2026-09-01T12:30:00Z");
const baseProduct = {
  title: "Pokémon TCG: 30th Celebration Elite Trainer Box",
  releaseLabel: "Released: 16 September 2026",
  purchaseLimit: "Limited to 1 Per Customer",
  allocationLimited: true,
  branches: ["The Entertainer Bluewater - Greenhithe", "The Entertainer Lakeside - Grays"],
};
function snap(overrides = {}) {
  return {
    schemaVersion: 1,
    surfaceId: "entertainer-pokemon-drop-hub",
    retailerId: "entertainer-uk",
    sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
    observedAt: "2026-09-01T12:29:00Z",
    pageTitle: "Pokemon at The Entertainer",
    products: [baseProduct],
    ...overrides,
  };
}
function memoryStore() {
  let state = null;
  return {
    async getRetailerIntelligenceSurfaceState() { return state; },
    async saveRetailerIntelligenceSurfaceState({ snapshot, previous, changed }) {
      state = {
        fingerprint: snapshot.fingerprint, snapshot,
        firstSeenAt: previous?.firstSeenAt || snapshot.observedAt,
        lastSeenAt: snapshot.observedAt,
        lastChangedAt: changed ? snapshot.observedAt : previous?.lastChangedAt || snapshot.observedAt,
      };
    },
  };
}
function reconcileLog(log, unmatched = []) {
  return async ({ entries }) => {
    const entry = entries[0];
    log.push(entry);
    return {
      matchedBranches: entry.targetBranches.length - unmatched.length,
      saved: entry.targetBranches.length - unmatched.length,
      duplicates: 0, rejected: [], unmatchedTargets: unmatched,
    };
  };
}

test("normalization fingerprints branch order and rejects unknown surfaces", () => {
  const a = normalizeRetailerIntelligenceSnapshot(snap(), NOW);
  const b = normalizeRetailerIntelligenceSnapshot(snap({ products: [{ ...baseProduct, branches: [...baseProduct.branches].reverse() }] }), NOW);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.throws(() => normalizeRetailerIntelligenceSnapshot({ ...snap(), surfaceId: "unknown" }, NOW), /allowlisted/);
});

test("first observation seeds advisory evidence but is notification-silent", async () => {
  const store = memoryStore();
  const reconciled = [];
  let published = 0;
  const result = await reconcileRetailerIntelligenceSurfaceSnapshot({
    store, snapshot: snap(), now: NOW,
    reconcile: reconcileLog(reconciled),
    publish: async () => { published += 1; return { published: true }; },
  });
  assert.equal(result.status, "baseline");
  assert.equal(result.baselineSilent, true);
  assert.equal(published, 0);
  assert.equal(reconciled[0].kind, "echo");
  assert.match(reconciled[0].evidenceBasis, /not verified/i);
});

test("unchanged page stays silent", async () => {
  const store = memoryStore();
  await reconcileRetailerIntelligenceSurfaceSnapshot({ store, snapshot: snap(), now: NOW, reconcile: reconcileLog([]), publish: async () => ({ published: true }) });
  const result = await reconcileRetailerIntelligenceSurfaceSnapshot({
    store, snapshot: snap({ observedAt: "2026-09-01T12:31:00Z" }), now: NOW + 120000,
    reconcile: async () => { throw new Error("unchanged must not reconcile"); },
    publish: async () => { throw new Error("unchanged must not publish"); },
  });
  assert.equal(result.status, "unchanged");
});

test("new product and allocation expansion remain Echo only", async () => {
  const store = memoryStore();
  await reconcileRetailerIntelligenceSurfaceSnapshot({ store, snapshot: snap(), now: NOW, reconcile: reconcileLog([]), publish: async () => ({ published: true }) });
  const logs = [], notifications = [];
  const second = { ...baseProduct, title: "Pokémon TCG: 30th Celebration Booster Bundle", branches: [baseProduct.branches[0]] };
  const result = await reconcileRetailerIntelligenceSurfaceSnapshot({
    store,
    snapshot: snap({ observedAt: "2026-09-01T12:35:00Z", products: [baseProduct, second] }),
    now: NOW + 360000,
    reconcile: reconcileLog(logs),
    publish: async (notification) => { notifications.push(notification); return { published: true }; },
  });
  assert.equal(result.status, "changed");
  assert.equal(logs[0].kind, "echo");
  assert.equal(notifications[0].stage, "ECHO");
  assert.match(notifications[0].body, /not confirmed/i);
  assert.ok(result.changes.some((change) => change.reasons.includes("product_added")));

  const a = normalizeRetailerIntelligenceSnapshot(snap(), NOW);
  const b = normalizeRetailerIntelligenceSnapshot(snap({ observedAt: "2026-09-01T12:32:00Z", products: [{ ...baseProduct, branches: [...baseProduct.branches, "The Entertainer Watford"] }] }), NOW + 180000);
  assert.ok(diffRetailerIntelligenceSnapshots(a, b)[0].reasons.includes("allocation_expanded"));
});

test("unmatched branch holds interrupt; contraction never becomes Vanished", async () => {
  const store = memoryStore();
  await reconcileRetailerIntelligenceSurfaceSnapshot({ store, snapshot: snap(), now: NOW, reconcile: reconcileLog([]), publish: async () => ({ published: true }) });
  let published = 0;
  const changed = snap({ observedAt: "2026-09-01T12:40:00Z", products: [{ ...baseProduct, branches: [...baseProduct.branches, "The Entertainer Unknown Branch"] }] });
  const result = await reconcileRetailerIntelligenceSurfaceSnapshot({
    store, snapshot: changed, now: NOW + 660000,
    reconcile: reconcileLog([], [{ target: "The Entertainer Unknown Branch", reason: "branch_not_found" }]),
    publish: async () => { published += 1; return { published: true }; },
  });
  assert.equal(published, 0);
  assert.equal(result.unmatchedTargets, 1);

  const first = normalizeRetailerIntelligenceSnapshot(snap(), NOW);
  const contracted = normalizeRetailerIntelligenceSnapshot(snap({ observedAt: "2026-09-01T12:42:00Z", products: [{ ...baseProduct, branches: [baseProduct.branches[0]] }] }), NOW + 780000);
  const reasons = diffRetailerIntelligenceSnapshots(first, contracted)[0].reasons;
  assert.ok(reasons.includes("allocation_contracted"));
  assert.ok(!reasons.includes("vanished"));
});
