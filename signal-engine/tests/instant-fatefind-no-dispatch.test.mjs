import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runSource = await readFile(new URL("../src/hosted/run.mjs", import.meta.url), "utf8");

test("instant evaluation does not flush unrelated notification backlog", () => {
  const instantFunction = runSource.match(/export async function runHostedFateFindNow\(fateFindId\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(instantFunction, /evaluateHostedFateFinds/);
  assert.doesNotMatch(instantFunction, /dispatchNotificationOutbox/);
});
