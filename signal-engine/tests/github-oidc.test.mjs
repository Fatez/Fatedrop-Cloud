import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { clearGithubOidcCacheForTest, verifyGithubActionsOidc } from "../src/http/github-oidc.mjs";

const NOW = 2_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
publicJwk.kid = "test-kid";
publicJwk.use = "sig";
publicJwk.alg = "RS256";

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(overrides = {}) {
  const header = b64({ alg: "RS256", typ: "JWT", kid: "test-kid" });
  const payload = b64({
    iss: "https://token.actions.githubusercontent.com",
    aud: "fatedrop-discovery-intake",
    repository: "Fatez/Fatedrop-Cloud",
    repository_owner: "Fatez",
    event_name: "issues",
    job_workflow_ref: "Fatez/Fatedrop-Cloud/.github/workflows/product-discovery-watch-intake.yml@refs/heads/main",
    actor: "Fatez",
    run_id: "123",
    sub: "repo:Fatez/Fatedrop-Cloud:ref:refs/heads/main",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    ...overrides,
  });
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function jwksFetch() {
  return async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("accepts signed OIDC only from the canonical main discovery workflow", async () => {
  clearGithubOidcCacheForTest();
  const result = await verifyGithubActionsOidc(jwt(), { fetchImpl: jwksFetch(), now: NOW });
  assert.equal(result.authorized, true);
  assert.equal(result.claims.repository, "Fatez/Fatedrop-Cloud");
  assert.equal(result.claims.eventName, "issues");
  assert.equal(result.claims.runId, "123");
});

test("rejects another repository even with a valid GitHub signature", async () => {
  clearGithubOidcCacheForTest();
  const result = await verifyGithubActionsOidc(jwt({ repository: "someone/other-repo" }), { fetchImpl: jwksFetch(), now: NOW });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "repository_mismatch");
});

test("rejects another workflow in the same repository", async () => {
  clearGithubOidcCacheForTest();
  const result = await verifyGithubActionsOidc(jwt({ job_workflow_ref: "Fatez/Fatedrop-Cloud/.github/workflows/other.yml@refs/heads/main" }), { fetchImpl: jwksFetch(), now: NOW });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "workflow_mismatch");
});

test("rejects wrong audience and stale tokens", async () => {
  clearGithubOidcCacheForTest();
  const wrongAudience = await verifyGithubActionsOidc(jwt({ aud: "something-else" }), { fetchImpl: jwksFetch(), now: NOW });
  assert.equal(wrongAudience.authorized, false);
  assert.equal(wrongAudience.reason, "audience_mismatch");

  clearGithubOidcCacheForTest();
  const expired = await verifyGithubActionsOidc(jwt({ iat: NOW - 1000, nbf: NOW - 1000, exp: NOW - 100 }), { fetchImpl: jwksFetch(), now: NOW });
  assert.equal(expired.authorized, false);
  assert.equal(expired.reason, "token_expired");
});

test("rejects a tampered token", async () => {
  clearGithubOidcCacheForTest();
  const raw = jwt();
  const [header, payload, signature] = raw.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.repository = "Fatez/Fatedrop-Cloud";
  claims.actor = "attacker";
  const tampered = `${header}.${b64(claims)}.${signature}`;
  const result = await verifyGithubActionsOidc(tampered, { fetchImpl: jwksFetch(), now: NOW });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "signature_invalid");
});
