import { env } from "../config/env.mjs";

const cache = new Map();
const hostCooldowns = new Map();
const ACCESS_BLOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 15 * 60 * 1000;

function requestHeaders(accept) {
  return {
    "user-agent": env.userAgent,
    accept,
    "accept-language": "en-GB,en;q=0.9",
  };
}

function hostFor(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

function accessError(message, cooldownMs, code) {
  const error = new Error(message);
  error.cooldownMs = cooldownMs;
  error.code = code;
  return error;
}

function beginHostCooldown(url, cooldownMs, reason) {
  const host = hostFor(url);
  if (!host || !Number.isFinite(cooldownMs) || cooldownMs <= 0) return;
  const now = Date.now();
  const existing = hostCooldowns.get(host);
  const until = Math.max(existing?.until ?? 0, now + cooldownMs);
  hostCooldowns.set(host, { until, reason: String(reason || "retailer access cooldown") });
}

function assertHostNotCoolingDown(url) {
  const host = hostFor(url);
  if (!host) return;
  const state = hostCooldowns.get(host);
  if (!state) return;
  const remainingMs = state.until - Date.now();
  if (remainingMs <= 0) {
    hostCooldowns.delete(host);
    return;
  }
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const error = new Error(`Retailer host cooldown active for ${host} (${remainingMinutes}m remaining); ${state.reason}`);
  error.code = "retailer_host_cooldown";
  throw error;
}

function assertAllowedResponse(response, kind) {
  if (response.status === 403 || response.status === 401) {
    throw accessError(
      `Retailer blocked ${kind} request (${response.status}); adapter paused rather than bypassing access controls.`,
      ACCESS_BLOCK_COOLDOWN_MS,
      "retailer_access_blocked",
    );
  }
  if (response.status === 429) {
    throw accessError(
      `Retailer rate-limited ${kind} request (429); adapter paused to protect the retailer/IP relationship.`,
      RATE_LIMIT_COOLDOWN_MS,
      "retailer_rate_limited",
    );
  }
  if (!response.ok) throw new Error(`${kind} request failed (${response.status})`);
}

function boundedTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return env.fetchTimeoutMs;
  return Math.max(3_000, Math.min(45_000, Math.round(parsed)));
}

export function retailerHostCooldownStatus(url, now = Date.now()) {
  const host = hostFor(url);
  const state = host ? hostCooldowns.get(host) : null;
  if (!state || state.until <= now) return { active: false, host, remainingMs: 0, reason: null };
  return { active: true, host, remainingMs: state.until - now, reason: state.reason };
}

export function clearRetailerHostCooldownsForTest() {
  hostCooldowns.clear();
}

export async function fetchCataloguePage(url, timeoutMs = env.fetchTimeoutMs) {
  assertHostNotCoolingDown(url);
  const previous = cache.get(url) || {};
  const requestTimeoutMs = boundedTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const headers = requestHeaders("text/html,application/xhtml+xml");
    if (previous.etag) headers["if-none-match"] = previous.etag;
    if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    if (response.status === 304 && previous.html) return { html: previous.html, status: 304, unchanged: true };
    assertAllowedResponse(response, "catalogue");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) throw new Error(`Unexpected catalogue content type: ${contentType}`);
    const html = await response.text();
    cache.set(url, { html, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
    return { html, status: response.status, unchanged: false };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = accessError(`catalogue request timed out after ${requestTimeoutMs}ms`, TIMEOUT_COOLDOWN_MS, "retailer_request_timeout");
      beginHostCooldown(url, TIMEOUT_COOLDOWN_MS, timeoutError.message);
      throw timeoutError;
    }
    if (Number.isFinite(error?.cooldownMs)) beginHostCooldown(url, error.cooldownMs, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchStructuredJson(url) {
  assertHostNotCoolingDown(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
  try {
    const response = await fetch(url, { headers: requestHeaders("application/json"), redirect: "follow", signal: controller.signal });
    assertAllowedResponse(response, "structured catalogue");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json") && !contentType.includes("text/plain")) throw new Error(`Unexpected structured catalogue content type: ${contentType}`);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("Structured catalogue returned invalid JSON"); }
    return { payload, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = accessError(`structured catalogue request timed out after ${env.fetchTimeoutMs}ms`, TIMEOUT_COOLDOWN_MS, "retailer_request_timeout");
      beginHostCooldown(url, TIMEOUT_COOLDOWN_MS, timeoutError.message);
      throw timeoutError;
    }
    if (Number.isFinite(error?.cooldownMs)) beginHostCooldown(url, error.cooldownMs, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
