import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRetailerHostCooldownsForTest,
  fetchCataloguePage,
  retailerHostCooldownStatus,
} from "../src/core/fetch.mjs";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRetailerHostCooldownsForTest();
});

test("403 starts a long host cooldown and prevents a second network request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("Forbidden", { status: 403, headers: { "content-type": "text/html" } });
  };

  const url = "https://cooldown-403.example/catalogue";
  await assert.rejects(() => fetchCataloguePage(url), /adapter paused rather than bypassing access controls/);
  assert.equal(calls, 1);
  const status = retailerHostCooldownStatus(url);
  assert.equal(status.active, true);
  assert.ok(status.remainingMs > 5 * 60 * 60 * 1000);

  await assert.rejects(() => fetchCataloguePage(`${url}?page=2`), /Retailer host cooldown active/);
  assert.equal(calls, 1);
});

test("429 starts a protective host cooldown", async () => {
  globalThis.fetch = async () => new Response("Too many requests", { status: 429, headers: { "content-type": "text/html" } });
  const url = "https://cooldown-429.example/catalogue";
  await assert.rejects(() => fetchCataloguePage(url), /rate-limited/);
  const status = retailerHostCooldownStatus(url);
  assert.equal(status.active, true);
  assert.ok(status.remainingMs > 60 * 60 * 1000);
});

test("successful HTML fetch does not create a cooldown", async () => {
  globalThis.fetch = async () => new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const url = "https://cooldown-ok.example/catalogue";
  const result = await fetchCataloguePage(url);
  assert.equal(result.status, 200);
  assert.equal(retailerHostCooldownStatus(url).active, false);
});
