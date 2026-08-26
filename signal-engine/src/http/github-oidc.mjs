import { createPublicKey, verify as verifySignature } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const DEFAULT_AUDIENCE = "fatedrop-discovery-intake";
const DEFAULT_REPOSITORY = "Fatez/Fatedrop-Cloud";
const DEFAULT_WORKFLOW_REF = "Fatez/Fatedrop-Cloud/.github/workflows/product-discovery-watch-intake.yml@refs/heads/main";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let jwksCache = null;
let jwksCachedAt = 0;

function decodeJsonSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function audienceMatches(value, expected) {
  if (Array.isArray(value)) return value.includes(expected);
  return value === expected;
}

async function loadJwks(fetchImpl = fetch) {
  const now = Date.now();
  if (jwksCache && now - jwksCachedAt < CACHE_TTL_MS) return jwksCache;
  const response = await fetchImpl(JWKS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub OIDC JWKS unavailable (${response.status})`);
  const body = await response.json();
  if (!Array.isArray(body?.keys) || !body.keys.length) throw new Error("GitHub OIDC JWKS contained no keys");
  jwksCache = body.keys;
  jwksCachedAt = now;
  return jwksCache;
}

export function clearGithubOidcCacheForTest() {
  jwksCache = null;
  jwksCachedAt = 0;
}

export async function verifyGithubActionsOidc(token, {
  fetchImpl = fetch,
  audience = DEFAULT_AUDIENCE,
  repository = DEFAULT_REPOSITORY,
  workflowRef = DEFAULT_WORKFLOW_REF,
  eventName = "issues",
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return { authorized: false, reason: "invalid_jwt_shape" };

  let header;
  let claims;
  try {
    header = decodeJsonSegment(parts[0]);
    claims = decodeJsonSegment(parts[1]);
  } catch {
    return { authorized: false, reason: "invalid_jwt_encoding" };
  }

  if (header?.alg !== "RS256" || !header?.kid) return { authorized: false, reason: "unsupported_jwt_header" };
  if (claims?.iss !== ISSUER) return { authorized: false, reason: "issuer_mismatch" };
  if (!audienceMatches(claims?.aud, audience)) return { authorized: false, reason: "audience_mismatch" };
  if (claims?.repository !== repository) return { authorized: false, reason: "repository_mismatch" };
  if (claims?.repository_owner !== "Fatez") return { authorized: false, reason: "owner_mismatch" };
  if (claims?.job_workflow_ref !== workflowRef) return { authorized: false, reason: "workflow_mismatch" };
  if (claims?.event_name !== eventName) return { authorized: false, reason: "event_mismatch" };

  const exp = Number(claims?.exp);
  const nbf = Number(claims?.nbf ?? claims?.iat);
  const iat = Number(claims?.iat);
  if (!Number.isFinite(exp) || exp < now - 30) return { authorized: false, reason: "token_expired" };
  if (Number.isFinite(nbf) && nbf > now + 30) return { authorized: false, reason: "token_not_yet_valid" };
  if (!Number.isFinite(iat) || iat < now - 15 * 60 || iat > now + 30) return { authorized: false, reason: "token_age_invalid" };

  let keys;
  try {
    keys = await loadJwks(fetchImpl);
  } catch (error) {
    return { authorized: false, reason: "jwks_unavailable", detail: String(error?.message || error) };
  }
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) return { authorized: false, reason: "signing_key_not_found" };

  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const signature = Buffer.from(parts[2], "base64url");
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const valid = verifySignature("RSA-SHA256", signingInput, publicKey, signature);
    if (!valid) return { authorized: false, reason: "signature_invalid" };
  } catch {
    return { authorized: false, reason: "signature_invalid" };
  }

  return {
    authorized: true,
    claims: {
      repository: claims.repository,
      repositoryId: claims.repository_id || null,
      actor: claims.actor || null,
      eventName: claims.event_name,
      workflowRef: claims.job_workflow_ref,
      runId: claims.run_id || null,
      issueSubject: claims.sub || null,
    },
  };
}

export function bearerToken(req) {
  const value = String(req?.headers?.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
