import { env } from "../config/env.mjs";

const cache = new Map();

export async function fetchCataloguePage(url) {
  const previous = cache.get(url) || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
  try {
    const headers = {
      "user-agent": env.userAgent,
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "en-GB,en;q=0.9",
    };
    if (previous.etag) headers["if-none-match"] = previous.etag;
    if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;
    const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
    if (response.status === 304 && previous.html) return { html: previous.html, status: 304, unchanged: true };
    if (response.status === 403 || response.status === 401) throw new Error(`Retailer blocked catalogue request (${response.status}); adapter disabled for this scan — FateDrop will not bypass access controls.`);
    if (response.status === 429) throw new Error("Retailer rate-limited catalogue request (429); back off rather than bypassing the limit.");
    if (!response.ok) throw new Error(`Catalogue request failed (${response.status})`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) throw new Error(`Unexpected catalogue content type: ${contentType}`);
    const html = await response.text();
    cache.set(url, { html, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
    return { html, status: response.status, unchanged: false };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
