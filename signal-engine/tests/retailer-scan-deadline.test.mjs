import test from "node:test";
import assert from "node:assert/strict";
import { sleep } from "../src/core/fetch.mjs";
import { currentRetailerScanSignal, runWithRetailerScanDeadline } from "../src/core/scan-deadline.mjs";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("hard retailer deadline releases a caller even when adapter work never settles", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runWithRetailerScanDeadline(
      () => new Promise(() => {}),
      { retailerId: "stuck-retailer", timeoutMs: 25 },
    ),
    (error) => error?.code === "retailer_scan_deadline" && /hard deadline/.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("deadline abort propagates into adapter pacing sleeps", async () => {
  let signal;
  await assert.rejects(
    runWithRetailerScanDeadline(async () => {
      signal = currentRetailerScanSignal();
      await sleep(10_000);
    }, { retailerId: "paced-retailer", timeoutMs: 30 }),
    (error) => error?.code === "retailer_scan_deadline",
  );
  assert.equal(signal?.aborted, true);
});

test("scheduled hard deadline closes the exact retailer run instead of leaving running telemetry", () => {
  assert.match(serverSource, /const runId = createRetailerRunId\(args\.retailer\.id\)/);
  assert.match(serverSource, /scanRetailer\(\{ \.\.\.args, runId \}\)/);
  assert.match(serverSource, /recordRetailerRunFinish\(store, \{[\s\S]*?runId,[\s\S]*?status: "failed"/);
  assert.match(serverSource, /source: "scheduled_scan_deadline"/);
});
