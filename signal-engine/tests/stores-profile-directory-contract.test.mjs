import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

test("retailer profile resolves through public Stores directory rather than scanner runtime only", () => {
  const profileStart = source.indexOf('const retailerProfileMatch = req.method === "GET"');
  const profileEnd = source.indexOf("return applicationHandler(req, res);", profileStart);
  assert.ok(profileStart >= 0 && profileEnd > profileStart, "retailer profile route should exist");

  const profileRoute = source.slice(profileStart, profileEnd);
  assert.match(profileRoute, /buildPublicRetailerDirectory\(\{ retailers, healthRows \}\)/);
  assert.match(profileRoute, /directory\.find\(\(item\) => String\(item\.id\) === retailerId\)/);
  assert.doesNotMatch(profileRoute, /retailers\.find\(\(item\) => String\(item\.id\) === retailerId\)/);
  assert.match(profileRoute, /monitoringConfigured: retailer\.monitoring\?\.configured === true/);
});
