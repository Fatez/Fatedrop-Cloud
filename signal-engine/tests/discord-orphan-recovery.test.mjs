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

test("reconciler excludes lifecycle events superseded on the same offer before late recovery", () => {
  const sourcePath = fileURLToPath(new URL("../src/notifications/discord-reconcile.mjs", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /FROM fatedrop_signals newer/);
  assert.match(source, /newer\.retailer_id = s\.retailer_id/);
  assert.match(source, /newer\.offer_id = s\.offer_id/);
  assert.match(source, /newer\.detected_at > s\.detected_at/);
  assert.match(source, /CASE WHEN last_attempt\.result IS NULL THEN 0 ELSE 1 END/);
});
