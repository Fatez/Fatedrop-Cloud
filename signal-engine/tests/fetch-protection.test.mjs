import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRetailerHostCooldownsForTest,
  fetchCataloguePage,
  isLikelyRetailerChallengeShell,
  retailerHostCooldownStatus,
} from "../src/core/fetch.mjs";

const CHALLENGE_SHELL = `<HTML><HEAD><TITLE></TITLE></HEAD><BODY><script src="/abc/TFgSrQgXt/xyz"></script><script>var i = document.createElement("iframe"); i.height=1; i.width=1; i.style.position='absolute'; i.style.top=0; i.style.left=0; i.style.border='none'; i.style.visibility='hidden'; document.body.appendChild(i); i.src='/abc/TFgSrQgXt/index.html';</script></BODY></HTML>`;

test("tiny script/iframe retailer shell is classified as an access challenge", () => {
  assert.equal(isLikelyRetailerChallengeShell(CHALLENGE_SHELL), true);
  assert.equal(
    isLikelyRetailerChallengeShell("<html><body><h1>Pokemon cards</h1><a href='/p/123'>Product</a></body></html>"),
    false,
  );
});

test("HTTP 200 challenge shell fails closed and starts a retailer cooldown", async (t) => {
  clearRetailerHostCooldownsForTest();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(CHALLENGE_SHELL, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
    clearRetailerHostCooldownsForTest();
  });

  const url = "https://retailer.example/pokemon";
  await assert.rejects(
    fetchCataloguePage(url),
    (error) => error?.code === "retailer_access_challenge",
  );

  const cooldown = retailerHostCooldownStatus(url);
  assert.equal(cooldown.active, true);
  assert.ok(cooldown.remainingMs > 0);
});