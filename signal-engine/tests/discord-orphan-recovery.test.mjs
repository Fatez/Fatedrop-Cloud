import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { discordRecoveryDecision } from "../src/notifications/discord-reconcile.mjs";

const NOW = 2_000_000;

function signal(state, ageSeconds) {
  return {
    id: `sig-${state}-${ageSeconds}`,
    state,
    detectedAt: NOW - ageSeconds,
  };
}

test("no-attempt Echo survives a deployment/restart gap long enough to recover", () => {
  const decision = discordRecoveryDecision({
    signal: signal("echo", 30 * 60),
    lastAttempt: null,
    now: NOW,
  });
  assert.equal(decision.recover, true);
  assert.equal(decision.reason, "no_attempt");
  assert.equal(decision.maxAgeSeconds, 60 * 60);
});

test("no-attempt Echo still expires rather than becoming an indefinitely late alert", () => {
  const decision = discordRecoveryDecision({
    signal: signal("echo", 61 * 60),
    lastAttempt: null,
    now: NOW,
  });
  assert.equal(decision.recover, false);
  assert.equal(decision.reason, "orphan_stale");
});

test("provider-attempted Echo keeps the strict existing five-minute freshness window", () => {
  const decision = discordRecoveryDecision({
    signal: signal("echo", 6 * 60),
    lastAttempt: { result: "failed", detail: "http_500", attemptedAt: NOW - 5 * 60 },
    now: NOW,
  });
  assert.equal(decision.recover, false);
  assert.equal(decision.reason, "stale");
  assert.equal(decision.maxAgeSeconds, 5 * 60);
});

test("no-attempt Manifested remains deliberately short-lived", () => {
  const recoverable = discordRecoveryDecision({
    signal: signal("manifested", 10 * 60),
    lastAttempt: null,
    now: NOW,
  });
  assert.equal(recoverable.recover, true);

  const stale = discordRecoveryDecision({
    signal: signal("manifested", 16 * 60),
    lastAttempt: null,
    now: NOW,
  });
  assert.equal(stale.recover, false);
  assert.equal(stale.reason, "orphan_stale");
});

test("outbox suppresses stale evidence when newer canonical lifecycle truth exists", () => {
  const sourcePath = fileURLToPath(new URL("../src/notifications/signal-outbox.mjs", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /superseded_by_newer_episode_event/);
  assert.match(source, /newer_episode\.scope_key=current_episode\.scope_key/);
  assert.match(source, /newer_event\.stage IN \('manifested','vanished'\)/);
  assert.match(source, /current_event\.stage IN \('whisper','echo'\)/);
});
