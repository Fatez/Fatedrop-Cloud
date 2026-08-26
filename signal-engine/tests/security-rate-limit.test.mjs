import assert from "node:assert/strict";
import test from "node:test";

import { clientRateLimitKey, createRateLimiter, rateLimitPolicy } from "../src/security/rate-limit.mjs";

function request(method, ip) {
  return {
    method,
    headers: { "x-forwarded-for": ip },
    socket: { remoteAddress: "10.0.0.10" },
  };
}

test("Local Radar is limited to 30 requests per minute per client", () => {
  let now = 1_000;
  const check = createRateLimiter({ now: () => now });
  const req = request("GET", "203.0.113.9");

  for (let index = 0; index < 30; index += 1) {
    assert.equal(check(req, "/api/local-radar").allowed, true);
  }

  const blocked = check(req, "/api/local-radar");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.policy, "local-radar");
  assert.equal(blocked.limit, 30);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds >= 1);

  now += 60_001;
  assert.equal(check(req, "/api/local-radar").allowed, true);
});

test("rate limits are isolated between client addresses", () => {
  const check = createRateLimiter({ now: () => 5_000 });
  const first = request("POST", "198.51.100.7");
  const second = request("POST", "198.51.100.8");

  for (let index = 0; index < 30; index += 1) check(first, "/api/fatefind/matches");
  assert.equal(check(first, "/api/fatefind/matches").allowed, false);
  assert.equal(check(second, "/api/fatefind/matches").allowed, true);
});

test("unlisted routes are not throttled by the application limiter", () => {
  const check = createRateLimiter({ now: () => 10_000 });
  const decision = check(request("GET", "192.0.2.10"), "/health");
  assert.equal(decision.allowed, true);
  assert.equal(decision.limited, false);
  assert.equal(decision.policy, null);
});

test("Cloudflare client IP takes precedence over proxy forwarding headers", () => {
  const req = {
    method: "GET",
    headers: {
      "cf-connecting-ip": "192.0.2.50",
      "x-real-ip": "203.0.113.50",
      "x-forwarded-for": "198.51.100.99, 203.0.113.44",
    },
    socket: { remoteAddress: "10.0.0.10" },
  };
  assert.equal(clientRateLimitKey(req), "ip:192.0.2.50");
});

test("proxy fallback uses the final appended forwarding address", () => {
  const req = {
    method: "GET",
    headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.44" },
    socket: { remoteAddress: "10.0.0.10" },
  };
  assert.equal(clientRateLimitKey(req), "ip:203.0.113.44");
});

test("expensive public routes have explicit rate-limit policies", () => {
  assert.equal(rateLimitPolicy("POST", "/api/fatefind/matches")?.limit, 30);
  assert.equal(rateLimitPolicy("GET", "/api/local-radar")?.limit, 30);
  assert.equal(rateLimitPolicy("GET", "/api/true-price")?.limit, 90);
  assert.equal(rateLimitPolicy("GET", "/api/catalogue")?.limit, 120);
  assert.equal(rateLimitPolicy("GET", "/v1/trader/finder")?.limit, 30);
});
