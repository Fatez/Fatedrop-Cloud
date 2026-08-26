import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { parseOfficialBranchPage } from "./national-branch-directory-sync.mjs";

const PROVIDER = "asda_official_directory";
const DEFAULT_LIMIT = 600;
const DEFAULT_CONCURRENCY = 8;
const ASDA_HOST = "storelocator.asda.com";
const ASDA_DIRECTORY_ROOT = "https://storelocator.asda.com/directory";

async function knownProviderIds(store) {
  if (typeof store?.listRetailerLocations === "function") {
    const rows = await store.listRetailerLocations({ limit: 20000 });
    return new Set((rows || [])
      .filter((row) => String(row.provider || "") === PROVIDER)
      .map((row) => String(row.providerId ?? row.provider_id ?? ""))
      .filter(Boolean));
  }
  if (typeof store?.pool !== "function") return new Set();
  const pool = await store.pool();
  const { rows } = await pool.query(
    "SELECT provider_id FROM fatedrop_retailer_locations WHERE provider=$1",
    [PROVIDER],
  );
  return new Set(rows.map((row) => String(row.provider_id || "")).filter(Boolean));
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function pathDepth(value) {
  try { return new URL(value).pathname.split("/").filter(Boolean).length; } catch { return -1; }
}

function extractLinks(body, baseUrl) {
  const links = new Set();
  for (const match of String(body || "").matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/gi, "&"), baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      links.add(url.toString());
    } catch {}
  }
  return [...links];
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "user-agent": "FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const input = Array.isArray(items) ? items : [];
  const results = new Array(input.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= input.length) return;
      results[index] = await mapper(input[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, input.length)) }, () => worker()));
  return results;
}

export async function discoverAsdaBranchUrlsFast({
  fetchImpl = fetch,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const maxConcurrency = Math.min(12, Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY));
  const rootHtml = await fetchText(ASDA_DIRECTORY_ROOT, { fetchImpl });
  const regionUrls = [...new Set(extractLinks(rootHtml, ASDA_DIRECTORY_ROOT)
    .map(canonicalUrl)
    .filter(Boolean)
    .filter((url) => new URL(url).hostname === ASDA_HOST)
    .filter((url) => pathDepth(url) === 1 && new URL(url).pathname !== "/directory"))];

  const regionPages = await mapConcurrent(regionUrls, maxConcurrency, async (url) => ({
    url,
    html: await fetchText(url, { fetchImpl }).catch(() => ""),
  }));
  const cityUrls = new Set();
  for (const page of regionPages) {
    for (const url of extractLinks(page.html, page.url)) {
      const normalized = canonicalUrl(url);
      if (!normalized || new URL(normalized).hostname !== ASDA_HOST) continue;
      if (pathDepth(normalized) === 2) cityUrls.add(normalized);
    }
  }

  const cityPages = await mapConcurrent([...cityUrls], maxConcurrency, async (url) => ({
    url,
    html: await fetchText(url, { fetchImpl }).catch(() => ""),
  }));
  const branches = new Set();
  for (const page of cityPages) {
    for (const url of extractLinks(page.html, page.url)) {
      const normalized = canonicalUrl(url);
      if (!normalized || new URL(normalized).hostname !== ASDA_HOST) continue;
      if (pathDepth(normalized) >= 3) branches.add(normalized);
    }
  }

  return [...branches].map((url) => ({ url, retailerId: "asda-uk", provider: PROVIDER }));
}

export async function runAsdaBranchDensitySync({
  store,
  fetchImpl = fetch,
  limit = DEFAULT_LIMIT,
  concurrency = DEFAULT_CONCURRENCY,
  discoverFn = discoverAsdaBranchUrlsFast,
  parseFn = parseOfficialBranchPage,
} = {}) {
  if (!store) throw new Error("ASDA branch density sync requires a store");
  const maxLimit = Math.min(1000, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const maxConcurrency = Math.min(12, Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY));

  let discovered;
  try {
    discovered = await discoverFn({ fetchImpl, concurrency: maxConcurrency });
  } catch (error) {
    return { provider: PROVIDER, status: "unavailable", discovered: 0, alreadyKnown: 0, attempted: 0, accepted: 0, saved: 0, rejected: 0, error: String(error?.message || error) };
  }

  const unique = new Map();
  for (const row of Array.isArray(discovered) ? discovered : []) {
    const url = canonicalUrl(row?.url);
    if (url) unique.set(url, { ...row, url });
  }
  const known = await knownProviderIds(store).catch(() => new Set());
  const pending = [...unique.values()].filter((row) => !known.has(row.url)).slice(0, maxLimit);
  const accepted = [];
  const rejected = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= pending.length) return;
      const row = pending[index];
      try {
        const parsed = await parseFn(row, { fetchImpl });
        if (!parsed?.location) {
          rejected.push({ url: row.url, reason: parsed?.reason || "branch_parse_failed" });
          continue;
        }
        accepted.push({
          ...parsed.location,
          openingDetails: {
            ...(parsed.location.openingDetails || {}),
            sourceType: "official_retailer_branch_page",
            sourceUrl: row.url,
            sourceAttribution: "ASDA official store locator",
            stockStatus: "unknown",
            stockClaim: false,
          },
        });
      } catch (error) {
        rejected.push({ url: row.url, reason: String(error?.message || error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, Math.max(1, pending.length)) }, () => worker()));
  const normalized = normalizeRetailerLocationBatch(accepted);
  const persisted = normalized.locations.length
    ? await upsertRetailerLocationsIntoStore(store, normalized.locations)
    : { saved: 0 };

  return {
    provider: PROVIDER,
    status: "ok",
    discovered: unique.size,
    alreadyKnown: unique.size - pending.length,
    attempted: pending.length,
    accepted: normalized.locations.length,
    saved: Number(persisted?.saved ?? normalized.locations.length) || 0,
    rejected: rejected.length + normalized.rejected.length,
    rejectionSamples: [...rejected, ...normalized.rejected].slice(0, 20),
    concurrency: maxConcurrency,
    truthRule: "ASDA directory evidence establishes branch identity only; stock remains unknown.",
  };
}
