import test from "node:test";
import assert from "node:assert/strict";
import { sleep } from "../src/core/fetch.mjs";
import { currentRetailerScanSignal, runWithRetailerScanDeadline } from "../src/core/scan-deadline.mjs";

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
