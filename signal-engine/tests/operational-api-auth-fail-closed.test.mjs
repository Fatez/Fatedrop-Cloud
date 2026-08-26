import assert from "node:assert/strict";
import test from "node:test";

import { resolveSignalApiToken } from "../src/config/env.mjs";

test("operational API token preserves an explicitly configured secret", () => {
  const token = resolveSignalApiToken("  configured-secret  ", () => "unused-fallback");
  assert.equal(token, "configured-secret");
});

test("operational API token fails closed when configuration is missing", () => {
  let fallbackCalls = 0;
  const token = resolveSignalApiToken("", () => {
    fallbackCalls += 1;
    return "unreachable-runtime-token";
  });

  assert.equal(fallbackCalls, 1);
  assert.equal(token, "unreachable-runtime-token");
  assert.notEqual(token, "");
});

test("operational API token treats whitespace-only configuration as missing", () => {
  const token = resolveSignalApiToken("   ", () => "fail-closed-token");
  assert.equal(token, "fail-closed-token");
});
