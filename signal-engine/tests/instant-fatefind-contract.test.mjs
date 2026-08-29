import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
const hostedSource = await readFile(new URL("../src/hosted/fatefind.mjs", import.meta.url), "utf8");

test("instant FateFind never triggers a retailer scan or changes scan cadence", () => {
  const instantRoute = serverSource.match(/if \(req\.method === "POST" && url\.pathname === "\/internal\/fatefind\/evaluate"\) \{([\s\S]*?)\n    \}/)?.[1] || "";
  assert.doesNotMatch(instantRoute, /scanAll|scanRetailer|scheduledScan/);
  assert.match(serverSource, /setInterval\(scheduledScan, env\.scanIntervalSeconds \* 1000\)/);
});

test("targeted evaluation preserves the same canonical fresh-offer trust boundary", () => {
  assert.match(hostedSource, /fateFindId = null/);
  assert.match(hostedSource, /HOSTED_OFFER_FRESHNESS_SECONDS/);
  assert.match(hostedSource, /HOSTED_MIN_STOCK_CONFIDENCE/);
  assert.match(hostedSource, /offerObservationTrust\(offer, \{ now \}\)/);
  assert.match(hostedSource, /evaluateFateFind\(find, offer, product\)/);
});
