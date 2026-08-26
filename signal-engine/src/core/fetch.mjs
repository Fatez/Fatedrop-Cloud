import { env } from "../config/env.mjs";
import { currentRetailerScanSignal, retailerScanDeadlineError } from "./scan-deadline.mjs";

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

function linkRetailerScanAbort(controller) {
  const signal = currentRetailerScanSignal();
  if (!signal) return { signal: null, cleanup() {} };
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    signal,
    cleanup() { signal.removeEventListener("abort", abort); },
  };
}

function throwScanAbort(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw retailerScanDeadlineError(null, env.scanDeadlineMs);
}

function stencilTemplate(options = {}) {
  const value = options?.stencilTemplate;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function catalogueCacheKey(url, template) {
  return template ? `${url}::stencil:${template}` : url;
}

function unwrapStencilHtml(text, template) {
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error("Stencil catalogue returned invalid JSON"); }

  if (typeof payload === "string") return payload;
  const content = payload?.content ?? payload;
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") throw new Error("Stencil catalogue returned no renderable content");

  const candidates = [template, `components/${template}`];
  for (const key of candidates) {
    if (typeof content[key] === "string") return content[key];
  }

  const strings = Object.values(content).filter((value) => typeof value === "string");
  if (strings.length === 1) return strings[0];
  throw new Error(`Stencil catalogue response did not include requested template: ${template}`);
}

function visibleTextFromHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyRetailerChallengeShell(html) {
  const raw = String(html || "");
  if (!raw || raw.length > 12_000) return false;
  const lower = raw.toLowerCase();
  const visible = visibleTextFromHtml(raw);
  const hasIframeBootstrap = lower.includes("document.createelement(\"iframe\")")
    || lower.includes("document.createelement('iframe')")
    || /<iframe\b/i.test(raw);
  const hasScriptBootstrap = /<script\b[^>]*(?:src=|>)/i.test(raw);
  const explicitChallenge = [
    "captcha",
    "access denied",
    "verify you are human",
    "checking your browser",
    "bot detection",
    "challenge-platform",
  ].some((marker) => lower.includes(marker));

  if (explicitChallenge && raw.length < 12_000) return true;
  if (!hasIframeBootstrap || !hasScriptBootstrap) return false;

  // A normal retailer page can contain scripts/iframes. The fail-closed signature
  // requires a tiny shell with effectively no shopper-visible content or links.
  const anchors = (raw.match(/<a\b/gi) || []).length;
  const forms = (raw.match(/<form\b/gi) || []).length;
  const images = (raw.match(/<img\b/gi) || []).length;
  const productHints = (raw.match(/product|price|basket|cart|stock/gi) || []).length;
  return visible.length < 80 && anchors === 0 && forms === 0 && images === 0 && productHints === 0;
}

function assertNoChallengeShell(html, kind) {
  if (!isLikelyRetailerChallengeShell(html)) return;
  throw accessError(
    `Retailer returned a protected ${kind} challenge shell with HTTP 200; adapter paused rather than treating the shell as an empty catalogue or attempting a bypass.`,
    ACCESS_BLOCK_COOLDOWN_MS,
    "retailer_access_challenge",
  );
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

export async function fetchCataloguePage(url, timeoutMs = env.fetchTimeoutMs, options = {}) {
  assertHostNotCoolingDown(url);
  const template = stencilTemplate(options);
  const cacheKey = catalogueCacheKey(url, template);
  const previous = cache.get(cacheKey) || {};
  const requestTimeoutMs = boundedTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const linked = linkRetailerScanAbort(controller);
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    throwScanAbort(linked.signal);
    const headers = requestHeaders(template ? "text/html,application/xhtml+xml,application/json" : "text/html,application/xhtml+xml");
    if (template) {
      // BigCommerce Stencil storefronts use this first-party partial-render contract
      // for faceted/category refreshes. It keeps a catalogue scan bounded to the
      // configured category instead of falling back to sitemap/product fan-out.
      headers["stencil-config"] = "{}";
      headers["stencil-options"] = JSON.stringify({ render_with: template });
      headers["x-requested-with"] = "stencil-utils";
      headers["x-xsrf-token"] = "";
      headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    if (previous.etag) headers["if-none-match"] = previous.etag;
    if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    if (response.status === 304 && previous.html) return { html: previous.html, status: 304, unchanged: true };
    assertAllowedResponse(response, "catalogue");
    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("json");
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    if ((!template && !isHtml) || (template && !isHtml && !isJson)) {
      throw new Error(`Unexpected catalogue content type: ${contentType}`);
    }
    const text = await response.text();
    const html = template && isJson ? unwrapStencilHtml(text, template) : text;
    assertNoChallengeShell(html, "catalogue");
    cache.set(cacheKey, { html, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
    return { html, status: response.status, unchanged: false };
  } catch (error) {
    throwScanAbort(linked.signal);
    if (controller.signal.aborted) {
      const timeoutError = accessError(`catalogue request timed out after ${requestTimeoutMs}ms`, TIMEOUT_COOLDOWN_MS, "retailer_request_timeout");
      beginHostCooldown(url, TIMEOUT_COOLDOWN_MS, timeoutError.message);
      throw timeoutError;
    }
    if (Number.isFinite(error?.cooldownMs)) beginHostCooldown(url, error.cooldownMs, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    linked.cleanup();
  }
}

export async function fetchStructuredJson(url) {
  assertHostNotCoolingDown(url);
  const controller = new AbortController();
  const linked = linkRetailerScanAbort(controller);
  const timer = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
  try {
    throwScanAbort(linked.signal);
    const response = await fetch(url, { headers: requestHeaders("application/json"), redirect: "follow", signal: controller.signal });
    assertAllowedResponse(response, "structured catalogue");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json") && !contentType.includes("text/plain")) throw new Error(`Unexpected structured catalogue content type: ${contentType}`);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("Structured catalogue returned invalid JSON"); }
    return { payload, status: response.status };
  } catch (error) {
    throwScanAbort(linked.signal);
    if (controller.signal.aborted) {
      const timeoutError = accessError(`structured catalogue request timed out after ${env.fetchTimeoutMs}ms`, TIMEOUT_COOLDOWN_MS, "retailer_request_timeout");
      beginHostCooldown(url, TIMEOUT_COOLDOWN_MS, timeoutError.message);
      throw timeoutError;
    }
    if (Number.isFinite(error?.cooldownMs)) beginHostCooldown(url, error.cooldownMs, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    linked.cleanup();
  }
}

export const sleep = (ms) => {
  const signal = currentRetailerScanSignal();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : retailerScanDeadlineError(null, env.scanDeadlineMs));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : retailerScanDeadlineError(null, env.scanDeadlineMs));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
};