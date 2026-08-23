import test from "node:test";
import assert from "node:assert/strict";
import {
  refreshBetaRuntimeReadiness,
  recordBetaRuntimeReadiness,
  summarizeBetaRuntimeReadiness,
} from "../src/telemetry/beta-runtime-readiness.mjs";

const runtime = { databaseConfigured: true, store: "postgres", hostedFateFindEnabled: false };
const healthyDiscord = {
  enabled: true,
  ready: true,
  routes: [
    { state: "whisper", companion: "Oru", ready: true },
    { state: "echo", companion: "Fenn", ready: true },
    { state: "manifested", companion: "Koru", ready: true },
    { state: "vanished", companion: "Nixon", ready: true },
  ],
};

function mockStore({ readinessRow = {}, notificationRow = {}, snapshots = [] } = {}) {
  const pool = {
    async query(sql) {
      if (sql.includes("FROM fatedrop_notification_outbox")) return { rows: [notificationRow] };
      if (sql.includes("FROM fatedrop_fate_matches")) return { rows: [readinessRow] };
      throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  return {
    async pool() { return pool; },
    async stats() { return { productsTracked: 5274, offersTracked: 6436, currentlyAvailable: 587 }; },
    async listRetailers() { return [{ id: "pokemon-center-uk", healthy: true }]; },
    async recordNetworkSnapshot(snapshot) { snapshots.push(snapshot); },
  };
}

test("web inbox can be infrastructure-ready while an eligible hosted hunt remains inactive behind the feature flag", async () => {
  const store = mockStore({
    readinessRow: {
      enabled_finds: 1,
      eligible_finds: 1,
      web_ready_finds: 1,
      push_ready_finds: 0,
      discord_ready_finds: 0,
      hosted_matches_24h: 0,
    },
    notificationRow: { total: 0, sent: 0, suppressed: 0, pending: 0, failed: 0, sending: 0, overdue: 0, stuck_sending: 0 },
  });
  const result = await refreshBetaRuntimeReadiness({ store, runtime, discord: healthyDiscord, now: 1_787_525_000 });
  assert.equal(result.infrastructureReady, true);
  assert.equal(result.ready, false);
  assert.equal(result.hostedFateFind.enabled, false);
  assert.equal(result.hostedFateFind.configured, true);
  assert.equal(result.hostedFateFind.eligibleFinds, 1);
  assert.equal(result.hostedFateFind.webReadyFinds, 1);
  assert.equal(result.hostedFateFind.pushReadyFinds, 0);
  assert.equal(result.hostedFateFind.discordReadyFinds, 0);
  assert.equal(result.hostedFateFind.notificationReadiness.ready, true);
});

test("beta readiness becomes green when hosted evaluation is active and the guaranteed web path is ready", () => {
  const result = summarizeBetaRuntimeReadiness({
    discord: healthyDiscord,
    hostedFateFind: { enabled: true, configured: true, eligibleFinds: 1, webReadyFinds: 1, notificationReadiness: { ready: true } },
  });
  assert.equal(result.infrastructureReady, true);
  assert.equal(result.ready, true);
});

test("beta readiness fails when an eligible hunt has no web inbox delivery path", () => {
  const result = summarizeBetaRuntimeReadiness({
    discord: healthyDiscord,
    hostedFateFind: { enabled: true, configured: true, eligibleFinds: 2, webReadyFinds: 1, notificationReadiness: { ready: true } },
    checkedAt: "2026-08-23T23:00:00.000Z",
  });
  assert.equal(result.ready, false);
});

test("beta readiness fails on overdue or stuck FateMatch notification delivery", () => {
  const result = summarizeBetaRuntimeReadiness({
    discord: healthyDiscord,
    hostedFateFind: { enabled: true, configured: true, eligibleFinds: 1, webReadyFinds: 1, notificationReadiness: { ready: false, overdue: 1 } },
  });
  assert.equal(result.ready, false);
});

test("runtime readiness snapshot persists only safe aggregate operational truth", async () => {
  const snapshots = [];
  const store = mockStore({
    snapshots,
    readinessRow: { enabled_finds: 1, eligible_finds: 1, web_ready_finds: 1, push_ready_finds: 0, discord_ready_finds: 0, hosted_matches_24h: 0 },
    notificationRow: { total: 0, sent: 0, suppressed: 0, pending: 0, failed: 0, sending: 0, overdue: 0, stuck_sending: 0 },
  });
  const result = await recordBetaRuntimeReadiness({ store, runtime, discord: healthyDiscord, now: 1_787_525_000 });
  assert.equal(result.recorded, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].metrics.betaRuntimeReadiness.discord.ready, true);
  assert.equal(snapshots[0].metrics.betaRuntimeReadiness.hostedFateFind.eligibleFinds, 1);
  const serialized = JSON.stringify(snapshots[0]);
  assert.equal(serialized.includes("user_id"), false);
  assert.equal(serialized.includes("token"), false);
});
