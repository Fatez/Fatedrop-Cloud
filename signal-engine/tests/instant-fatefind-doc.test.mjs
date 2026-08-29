import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runSource = await readFile(new URL("../src/hosted/run.mjs", import.meta.url), "utf8");

test("instant evaluation is additive to the unchanged scheduled hosted FateFind cycle", () => {
  assert.match(runSource, /export async function runHostedFateFindNow/);
  assert.match(runSource, /export async function runHostedFateFindCycle/);
  assert.match(runSource, /maxFindsPerRun/);
});
