import test from "node:test";
import assert from "node:assert/strict";
import { fetchAsmodeeText } from "../src/rrp/asmodee-authority.mjs";

function response({ ok, status, body = "", retryAfter = null }) {
  return {
    ok,
    status,
    headers: { get: (name) => name.toLowerCase() === "retry-after" ? retryAfter : null },
    text: async () => body,
  };
}

test("retries transient 429 responses then succeeds", async () => {
  let calls = 0;
  const delays = [];
  const text = await fetchAsmodeeText("https://www.asmodee.co.uk/products/test", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response({ ok: false, status: 429, retryAfter: "0" });
      return response({ ok: true, status: 200, body: "ok" });
    },
    attempts: 3,
    sleepImpl: async (ms) => { delays.push(ms); },
  });

  assert.equal(text, "ok");
  assert.equal(calls, 2);
  assert.equal(delays.length, 1);
});

test("retries transient network failures then succeeds", async () => {
  let calls = 0;
  const text = await fetchAsmodeeText("https://www.asmodee.co.uk/products/test", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket reset");
      return response({ ok: true, status: 200, body: "ok" });
    },
    attempts: 3,
    sleepImpl: async () => {},
  });

  assert.equal(text, "ok");
  assert.equal(calls, 2);
});

test("does not retry non-transient 404 responses", async () => {
  let calls = 0;
  await assert.rejects(
    fetchAsmodeeText("https://www.asmodee.co.uk/products/missing", {
      fetchImpl: async () => {
        calls += 1;
        return response({ ok: false, status: 404 });
      },
      attempts: 4,
      sleepImpl: async () => { throw new Error("sleep should not be called"); },
    }),
    /request failed 404/,
  );
  assert.equal(calls, 1);
});

test("stops after bounded attempts on repeated 503 responses", async () => {
  let calls = 0;
  await assert.rejects(
    fetchAsmodeeText("https://www.asmodee.co.uk/products/test", {
      fetchImpl: async () => {
        calls += 1;
        return response({ ok: false, status: 503 });
      },
      attempts: 3,
      sleepImpl: async () => {},
    }),
    /request failed 503/,
  );
  assert.equal(calls, 3);
});
