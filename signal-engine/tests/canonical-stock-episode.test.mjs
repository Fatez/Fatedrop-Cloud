import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  availabilityEffectForStage,
  canonicalEpisodeTransition,
} from "../src/core/canonical-stock-episode.mjs";
import { persistCanonicalSignals } from "../src/stores/canonical-signal-ledger.mjs";

const migration = await readFile(new URL("../database/canonical-stock-episodes.sql", import.meta.url), "utf8");

test("episode schema makes Whisper and Echo evidence-only and Manifested the first availability state", () => {
  assert.match(migration, /stage IN \('whisper','echo'\) AND availability_effect='none'/);
  assert.match(migration, /stage='manifested' AND availability_effect='available'/);
  assert.match(migration, /stage='vanished' AND availability_effect='unavailable'/);
  assert.match(migration, /availability_state IN \('never_manifested', 'available', 'vanished'\)/);
  assert.match(migration, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE\(signal_id, channel, destination_key\)/);
  assert.match(migration, /does not backfill historical signals/);
  assert.match(migration, /fatedrop_enforce_stock_episode_event_truth/);
  assert.match(migration, /Vanished requires prior canonical Manifested availability/);
  assert.match(migration, /prior\.stage='manifested'/);
});

test("Whisper opens evidence without claiming availability", () => {
  const transition = canonicalEpisodeTransition({ stage: "whisper", occurredAt: 100 });
  assert.deepEqual(transition, {
    accepted: true,
    create: true,
    cycleNumber: 1,
    episodeState: "evidence_open",
    availabilityState: "never_manifested",
  });
  assert.equal(availabilityEffectForStage("whisper"), "none");
  assert.equal(availabilityEffectForStage("echo"), "none");
});

test("Echo enriches an evidence episode without changing its availability", () => {
  const transition = canonicalEpisodeTransition({
    stage: "echo",
    occurredAt: 110,
    currentEpisode: {
      cycleNumber: 1,
      episodeState: "evidence_open",
      availabilityState: "never_manifested",
      manifestedAt: null,
      latestEventAt: 100,
    },
  });
  assert.equal(transition.accepted, true);
  assert.equal(transition.availabilityState, "never_manifested");
  assert.equal(transition.episodeState, "evidence_open");
});

test("Manifested creates canonical availability and evidence stages cannot overwrite it", () => {
  const manifested = canonicalEpisodeTransition({
    stage: "manifested",
    occurredAt: 120,
    currentEpisode: {
      cycleNumber: 1,
      episodeState: "evidence_open",
      availabilityState: "never_manifested",
      manifestedAt: null,
      latestEventAt: 110,
    },
  });
  assert.equal(manifested.availabilityState, "available");
  assert.equal(manifested.episodeState, "available");

  const laterEcho = canonicalEpisodeTransition({
    stage: "echo",
    occurredAt: 125,
    currentEpisode: {
      cycleNumber: 1,
      episodeState: "available",
      availabilityState: "available",
      manifestedAt: 120,
      latestEventAt: 120,
    },
  });
  assert.equal(laterEcho.availabilityState, "available");
  assert.equal(laterEcho.episodeState, "available");
});

test("Vanished fails closed unless the current episode has prior Manifested availability", () => {
  const noEpisode = canonicalEpisodeTransition({ stage: "vanished", occurredAt: 130 });
  const evidenceOnly = canonicalEpisodeTransition({
    stage: "vanished",
    occurredAt: 130,
    currentEpisode: {
      cycleNumber: 1,
      episodeState: "evidence_open",
      availabilityState: "never_manifested",
      manifestedAt: null,
      latestEventAt: 120,
    },
  });
  assert.equal(noEpisode.conflictReason, "vanished_without_prior_manifested");
  assert.equal(evidenceOnly.conflictReason, "vanished_without_prior_manifested");

  const valid = canonicalEpisodeTransition({
    stage: "vanished",
    occurredAt: 130,
    currentEpisode: {
      cycleNumber: 1,
      episodeState: "available",
      availabilityState: "available",
      manifestedAt: 120,
      latestEventAt: 120,
    },
  });
  assert.equal(valid.accepted, true);
  assert.equal(valid.episodeState, "closed");
  assert.equal(valid.availabilityState, "vanished");
});

test("new evidence after Vanished starts a new episode instead of rewriting history", () => {
  const transition = canonicalEpisodeTransition({
    stage: "whisper",
    occurredAt: 200,
    currentEpisode: {
      cycleNumber: 3,
      episodeState: "closed",
      availabilityState: "vanished",
      manifestedAt: 150,
      latestEventAt: 180,
    },
  });
  assert.equal(transition.create, true);
  assert.equal(transition.cycleNumber, 4);
  assert.equal(transition.availabilityState, "never_manifested");
});

test("out-of-order lifecycle evidence is flagged instead of guessed into an episode", () => {
  const transition = canonicalEpisodeTransition({
    stage: "manifested",
    occurredAt: 90,
    currentEpisode: {
      cycleNumber: 1,
      episodeState: "evidence_open",
      availabilityState: "never_manifested",
      manifestedAt: null,
      latestEventAt: 100,
    },
  });
  assert.equal(transition.accepted, false);
  assert.equal(transition.conflictReason, "out_of_order_episode_event");
});

function signal(state, overrides = {}) {
  return {
    id: `sig_${state}`,
    state,
    productId: "prod_1",
    offerId: "offer_1",
    retailerId: "retailer_1",
    retailerName: "Retailer",
    title: "Product",
    productType: "booster_pack",
    url: "https://example.com/product",
    pricePence: 499,
    stockStatus: state === "vanished" ? "out_of_stock" : "unknown",
    confidence: 0.9,
    detectedAt: 200,
    reason: "test",
    evidence: [{ kind: "signal_kind", value: "test" }],
    ...overrides,
  };
}

test("orphan Vanished is quarantined and never inserted into the public signal stream", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM fatedrop_stock_episode_events")) return { rows: [] };
      if (sql.includes("FROM fatedrop_stock_episodes")) {
        return {
          rows: [{
            id: "ep_1",
            cycle_number: 1,
            episode_state: "evidence_open",
            availability_state: "never_manifested",
            manifested_at: null,
            latest_event_at: 150,
          }],
        };
      }
      return { rows: [] };
    },
  };

  const result = await persistCanonicalSignals(client, [signal("vanished")], { now: 201 });
  assert.deepEqual(result.acceptedSignalIds, []);
  assert.deepEqual(result.conflictSignalIds, ["sig_vanished"]);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO fatedrop_stock_episode_conflicts")), true);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO fatedrop_signals")), false);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO fatedrop_signal_delivery_outbox")), false);
});

test("accepted signal, episode event and one idempotent Discord obligation share the persistence unit", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM fatedrop_stock_episode_events")) return { rows: [] };
      if (sql.includes("FROM fatedrop_stock_episodes")) return { rows: [] };
      if (sql.includes("INSERT INTO fatedrop_signals")) return { rows: [{ id: "sig_whisper" }] };
      return { rows: [] };
    },
  };

  const result = await persistCanonicalSignals(client, [signal("whisper")], { now: 201 });
  assert.deepEqual(result.acceptedSignalIds, ["sig_whisper"]);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO fatedrop_signals")), true);
  assert.equal(calls.some(({ sql }) => sql.includes("INSERT INTO fatedrop_stock_episode_events")), true);
  const outbox = calls.find(({ sql }) => sql.includes("INSERT INTO fatedrop_signal_delivery_outbox"));
  assert.ok(outbox);
  assert.match(outbox.values[1], /^lifecycle:v1:sig_whisper:discord:lifecycle:whisper$/);
});

test("history-only Manifested anchors are ledgered as suppressed, never queued for Discord", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM fatedrop_stock_episode_events")) return { rows: [] };
      if (sql.includes("FROM fatedrop_stock_episodes")) return { rows: [] };
      return { rows: [] };
    },
  };
  const history = signal("manifested", {
    stockStatus: "in_stock",
    evidence: [{ kind: "delivery_policy", value: "history_only" }],
  });
  await persistCanonicalSignals(client, [history], { now: 201 });
  const outbox = calls.find(({ sql }) => sql.includes("INSERT INTO fatedrop_signal_delivery_outbox"));
  assert.equal(outbox.values[5], "history_only");
  assert.equal(outbox.values[6], "suppressed");
});
