const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;

const POLICIES = Object.freeze([
  { method: "POST", path: "/api/fatefind/matches", limit: 30, windowMs: DEFAULT_WINDOW_MS, name: "fatefind" },
  { method: "GET", path: "/api/local-radar", limit: 30, windowMs: DEFAULT_WINDOW_MS, name: "local-radar" },
  { method: "GET", path: "/api/true-price", limit: 90, windowMs: DEFAULT_WINDOW_MS, name: "true-price" },
  { method: "GET", path: "/api/catalogue", limit: 120, windowMs: DEFAULT_WINDOW_MS, name: "catalogue" },
  { method: "GET", path: "/api/signals", limit: 120, windowMs: DEFAULT_WINDOW_MS, name: "signals" },
  { method: "GET", prefix: "/api/encounters", limit: 60, windowMs: DEFAULT_WINDOW_MS, name: "encounters" },
  { method: "GET", prefix: "/api/calendar-events", limit: 60, windowMs: DEFAULT_WINDOW_MS, name: "calendar-events" },
  { method: "GET", path: "/v1/trader/finder", limit: 30, windowMs: DEFAULT_WINDOW_MS, name: "trader-finder" },
  { method: "GET", prefix: "/v1/trader/", limit: 120, windowMs: DEFAULT_WINDOW_MS, name: "trader-read" },
  { method: "POST", prefix: "/v1/trader/", limit: 60, windowMs: DEFAULT_WINDOW_MS, name: "trader-write" },
  { method: "PATCH", prefix: "/v1/trader/", limit: 60, windowMs: DEFAULT_WINDOW_MS, name: "trader-write" },
  { method: "DELETE", prefix: "/v1/trader/", limit: 60, windowMs: DEFAULT_WINDOW_MS, name: "trader-write" },
]);

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function clientRateLimitKey(req) {
  const forwarded = String(firstHeaderValue(req?.headers?.["x-forwarded-for"]) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (forwarded.length) return `ip:${forwarded.at(-1)}`;

  const realIp = String(firstHeaderValue(req?.headers?.["x-real-ip"]) || "").trim();
  if (realIp) return `ip:${realIp}`;

  const remote = String(req?.socket?.remoteAddress || "unknown").trim() || "unknown";
  return `ip:${remote}`;
}

export function rateLimitPolicy(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedPath = String(pathname || "/");
  return POLICIES.find((policy) => {
    if (policy.method !== normalizedMethod) return false;
    if (policy.path) return policy.path === normalizedPath;
    return policy.prefix ? normalizedPath.startsWith(policy.prefix) : false;
  }) || null;
}

export function createRateLimiter({ now = () => Date.now(), maxKeys = DEFAULT_MAX_KEYS } = {}) {
  const buckets = new Map();
  const safeMaxKeys = Math.max(100, Number(maxKeys) || DEFAULT_MAX_KEYS);

  function evictOldestIfNeeded(key) {
    if (buckets.has(key) || buckets.size < safeMaxKeys) return;
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }

  return function checkRateLimit(req, pathname) {
    const policy = rateLimitPolicy(req?.method, pathname);
    if (!policy) return { allowed: true, limited: false, policy: null };

    const timestamp = now();
    const clientKey = clientRateLimitKey(req);
    const bucketKey = `${policy.name}:${clientKey}`;
    evictOldestIfNeeded(bucketKey);

    let bucket = buckets.get(bucketKey);
    if (!bucket || timestamp >= bucket.resetAt) {
      bucket = { count: 0, resetAt: timestamp + policy.windowMs };
      buckets.delete(bucketKey);
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, policy.limit - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));
    const allowed = bucket.count <= policy.limit;

    return {
      allowed,
      limited: !allowed,
      policy: policy.name,
      limit: policy.limit,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    };
  };
}

export const RATE_LIMIT_POLICIES = POLICIES;
