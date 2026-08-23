import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { persistDiscordRouteHealth } from "../src/telemetry/discord-route-health.mjs";

const serverSource = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

test("Signal Engine exposes read-only FateFind readiness and persists Discord route health without signal ingestion", () => {
  assert.match(serverSource, /\/api\/fatefind-readiness/);
  assert.match(serverSource, /buildHostedFateFindReadiness\(store\)/);
  assert.match(serverSource, /persistDiscordRouteHealth\(store, outcome\)/);
  assert.doesNotMatch(serverSource, /fatefind-readiness[\s\S]{0,400}ingestRetailerProducts/);
});

test("Discord route health is attached only to the latest network telemetry snapshot", async () => {
  const calls = [];
  const store = {
    async pool() {
      return {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [{ id: "net-latest", measured_at: 1234 }] };
        },
      };
    },
  };
  const health = {
    enabled: true,
    ready: true,
    checkedAt: "2026-08-23T22:50:00.000Z",
    routes: [{ state: "echo", companion: "Fenn", configured: true, ready: true, reason: null, botUsername: "Fenn", channelName: "fenn-echoes" }],
  };
  const result = await persistDiscordRouteHealth(store, health);
  assert.equal(result.persisted, true);
  assert.equal(result.measuredAt, 1234);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /jsonb_set/);
  assert.match(calls[0].sql, /discordRouteHealth/);
  assert.match(calls[0].sql, /ORDER BY measured_at DESC LIMIT 1/);
  assert.deepEqual(JSON.parse(calls[0].params[0]), health);
});
