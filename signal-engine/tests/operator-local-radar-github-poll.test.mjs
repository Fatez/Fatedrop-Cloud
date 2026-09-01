import assert from "node:assert/strict";
import test from "node:test";

import {
  listOperatorIssues,
  operatorGithubConfig,
  pollOperatorIssues,
} from "../src/encounters/operator-local-radar-intake.mjs";

function issue(number = 901) {
  return {
    number,
    state: "open",
    title: "[FATEDROP ECHO] operator test fixture",
    body: "{}",
    created_at: "2026-09-01T20:00:00Z",
    updated_at: "2026-09-01T20:00:00Z",
    user: { login: "Fatez" },
  };
}

test("production operator polling fails closed without an authenticated GitHub token", async () => {
  let calls = 0;
  await assert.rejects(
    () => listOperatorIssues(async () => { calls += 1; }, { token: null, authenticated: false, required: true }),
    (error) => error?.code === "github_auth_missing",
  );
  assert.equal(calls, 0);
});

test("operator issue reads use bearer authentication without leaking the token", async () => {
  let request = null;
  const issues = await listOperatorIssues(async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify([issue()]), { status: 200, headers: { "content-type": "application/json" } });
  }, { token: "test-read-only-token", authenticated: true, required: true });

  assert.equal(issues.length, 1);
  assert.equal(request.options.headers.Authorization, "Bearer test-read-only-token");
  assert.equal(request.options.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.doesNotMatch(JSON.stringify(issues), /test-read-only-token/);
});

test("transient GitHub failures receive one bounded retry", async () => {
  let calls = 0;
  const issues = await listOperatorIssues(async () => {
    calls += 1;
    if (calls === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify([issue(902)]), { status: 200, headers: { "content-type": "application/json" } });
  }, { token: "test-read-only-token", authenticated: true, required: true });
  assert.equal(calls, 2);
  assert.equal(issues[0].number, 902);
});

test("public operator health receives a redacted actionable GitHub failure code", async () => {
  const originalRailway = process.env.RAILWAY_ENVIRONMENT_NAME;
  const originalToken = process.env.FATEDROP_GITHUB_OPERATOR_TOKEN;
  process.env.RAILWAY_ENVIRONMENT_NAME = "production";
  delete process.env.FATEDROP_GITHUB_OPERATOR_TOKEN;
  try {
    const result = await pollOperatorIssues({ store: {}, fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.deepEqual(result, { status: "failed", errorCode: "github_auth_missing" });
  } finally {
    if (originalRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
    else process.env.RAILWAY_ENVIRONMENT_NAME = originalRailway;
    if (originalToken === undefined) delete process.env.FATEDROP_GITHUB_OPERATOR_TOKEN;
    else process.env.FATEDROP_GITHUB_OPERATOR_TOKEN = originalToken;
  }
});

test("GitHub operator token configuration exposes only its boolean readiness", () => {
  const original = process.env.FATEDROP_GITHUB_OPERATOR_TOKEN;
  try {
    process.env.FATEDROP_GITHUB_OPERATOR_TOKEN = "secret-value";
    const config = operatorGithubConfig();
    assert.equal(config.authenticated, true);
    assert.equal(config.token, "secret-value");
  } finally {
    if (original === undefined) delete process.env.FATEDROP_GITHUB_OPERATOR_TOKEN;
    else process.env.FATEDROP_GITHUB_OPERATOR_TOKEN = original;
  }
});
