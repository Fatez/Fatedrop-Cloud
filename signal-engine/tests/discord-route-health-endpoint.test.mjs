import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serverSource = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

test("Signal Engine exposes cached Discord route health without creating signal records", () => {
  assert.match(serverSource, /\/api\/discord-route-health/);
  assert.match(serverSource, /getDiscordRouteHealth\(\)/);
  assert.match(serverSource, /refreshDiscordRouteHealth\(\)/);
  assert.doesNotMatch(serverSource, /discord-route-health[\s\S]{0,300}ingestRetailerProducts/);
});
