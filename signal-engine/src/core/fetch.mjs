import { env } from "../config/env.mjs";

const cache = new Map();

function requestHeaders(accept) {
  return {
    "user-agent": env.userAgent,
    accept,
    "accept-language": "en-GB,en;q=0.9",
  };
}

function assertAllowedResponse(response, kind) {
  if (response.status === 403 || response.status === 401) throw new Error(`Retailer blocked ${kind} request (${response.status}); adapter disabled for this scan — FateDrop will not bypass access controls.`);
  if (response.status === 429) throw new Error(`Retailer rate-limited ${kind} request (429); back off rather than bypassing the limit.`);
  if (!response.ok) throw new Error(`${kind} request failed (${response.status})`);
}

export async function fetchCataloguePage(url) {
  const previous = cache.get(url) || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
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
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchStructuredJson(url) {
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
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
