import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/http/fatedrop-server.mjs", import.meta.url), "utf8");

test("FateDrop router applies abuse limits before expensive route dispatch", () => {
  assert.match(source, /import \{ createRateLimiter \} from "\.\.\/security\/rate-limit\.mjs"/);
  assert.match(source, /const checkRateLimit=createRateLimiter\(\)/);
  assert.match(source, /const rateLimit=checkRateLimit\(req,url\.pathname\)/);
  assert.match(source, /if\(!rateLimit\.allowed\)return rateLimited\(res,rateLimit\)/);
});

test("rate-limit rejection is explicit and cache-safe", () => {
  assert.match(source, /res\.writeHead\(429/);
  assert.match(source, /"retry-after"/);
  assert.match(source, /"x-ratelimit-limit"/);
  assert.match(source, /"cache-control": "no-store"/);
  assert.match(source, /code: "RATE_LIMITED"/);
});
