import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";

const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const DEFAULT_BRANCH_FETCH_LIMIT = 250;
const DEFAULT_TOYSHOP_FALLBACK_DISCOVERY_LIMIT = 120;
const DEFAULT_TOYSHOP_FALLBACK_CONCURRENCY = 8;
const TOYSHOP_HOST = "www.thetoyshop.com";

export const TOYSHOP_STORE_FALLBACK_SEEDS = Object.freeze([
  "https://www.thetoyshop.com/store/watford",
  "https://www.thetoyshop.com/store/birmingham",
  "https://www.thetoyshop.com/store/arndale",
  "https://www.thetoyshop.com/store/cardiff",
  "https://www.thetoyshop.com/store/st-enoch",
  "https://www.thetoyshop.com/store/aberdeen",
  "https://www.thetoyshop.com/store/antrim",
  "https://www.thetoyshop.com/store/tesco-newcastle-upon-tyne-extra",
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value = "") {
  return decodeEntities(String(value).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePostcode(value) {
  const match = String(value || "").toUpperCase().match(UK_POSTCODE_RE);
  if (!match) return null;
  const compact = match[1].replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function titleFromHtml(html, fallback) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const raw = stripTags(h1 || title || fallback || "");
  return raw
    .replace(/\s*[|–-]\s*(?:ASDA|Tesco|The Toyshop Site|The Entertainer).*$/i, "")
    .trim() || text(fallback) || "Retail store";
}

function extractLinks(body, baseUrl) {
  const links = new Set();
  const hrefRe = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const match of body.matchAll(hrefRe)) {
    try {
      const url = new URL(decodeEntities(match[1]), baseUrl);
      if (["http:", "https:"].includes(url.protocol)) {
        url.hash = "";
        links.add(url.toString());
      }
    } catch {}
  }
  return [...links];
}

function extractSitemapUrls(xml) {
  const urls = [];
  for (const match of String(xml || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    try { urls.push(new URL(decodeEntities(match[1])).toString()); } catch {}
  }
  return [...new Set(urls)];
}

function jsonLdObjects(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html || "").matchAll(re)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) results.push(...parsed);
      else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed["@graph"])) results.push(...parsed["@graph"]);
        results.push(parsed);
      }
    } catch {}
  }
  return results;
}

function structuredLocation(html) {
  for (const row of jsonLdObjects(html)) {
    const address = row?.address && typeof row.address === "object" ? row.address : null;
    const geo = row?.geo && typeof row.geo === "object" ? row.geo : null;
    const postcode = normalizePostcode(address?.postalCode);
    const latitude = Number(geo?.latitude);
    const longitude = Number(geo?.longitude);
    if (postcode || Number.isFinite(latitude) || Number.isFinite(longitude)) {
      const addressParts = [address?.streetAddress, address?.addressLocality, address?.addressRegion, postcode].filter(Boolean);
      return {
        postcode,
        address: addressParts.length ? addressParts.join(", ") : null,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        phone: text(row?.telephone),
        name: text(row?.name),
      };
    }
  }
  return null;
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5",
        "user-agent": "FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function geocodeUkPostcode(postcode, { fetchImpl = fetch } = {}) {
  const normalized = normalizePostcode(postcode);
  if (!normalized) return null;
  const response = await fetchImpl(`https://api.postcodes.io/postcodes/${encodeURIComponent(normalized)}`, {
    headers: { accept: "application/json", "user-agent": "FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)" },
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const latitude = Number(body?.result?.latitude);
  const longitude = Number(body?.result?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function classifyToyshopStore(url) {
  const parsed = new URL(url);
  if (parsed.hostname.toLowerCase() !== TOYSHOP_HOST) return null;
  const pathname = parsed.pathname.toLowerCase();
  if (!pathname.startsWith("/store/")) return null;
  if (pathname.startsWith("/store/tesco-")) {
    return { retailerId: "tesco-uk", provider: "entertainer_official_stockist" };
  }
  return { retailerId: "entertainer-uk", provider: "entertainer_official_directory" };
}

function canonicalToyshopStoreUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== TOYSHOP_HOST || !url.pathname.toLowerCase().startsWith("/store/")) return null;
    url.protocol = "https:";
    url.hostname = TOYSHOP_HOST;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function crawlToyshopOfficialStoreGraph({
  fetchImpl = fetch,
  seeds = TOYSHOP_STORE_FALLBACK_SEEDS,
  discoveryLimit = DEFAULT_TOYSHOP_FALLBACK_DISCOVERY_LIMIT,
  concurrency = DEFAULT_TOYSHOP_FALLBACK_CONCURRENCY,
} = {}) {
  const maxPages = Math.min(250, Math.max(1, Number(discoveryLimit) || DEFAULT_TOYSHOP_FALLBACK_DISCOVERY_LIMIT));
  const maxConcurrency = Math.min(12, Math.max(1, Number(concurrency) || DEFAULT_TOYSHOP_FALLBACK_CONCURRENCY));
  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const rows = new Map();

  const enqueue = (candidate) => {
    const url = canonicalToyshopStoreUrl(candidate);
    if (!url || queued.has(url) || visited.has(url)) return;
    if (!classifyToyshopStore(url)) return;
    queued.add(url);
    queue.push(url);
  };
  for (const seed of Array.isArray(seeds) ? seeds : []) enqueue(seed);

  while (queue.length && visited.size < maxPages) {
    const batch = [];
    while (queue.length && batch.length < maxConcurrency && visited.size < maxPages) {
      const url = queue.shift();
      queued.delete(url);
      if (!url || visited.has(url)) continue;
      visited.add(url);
      batch.push(url);
    }
    const fetched = await Promise.all(batch.map(async (url) => {
      try {
        return { url, html: await fetchText(url, { fetchImpl }) };
      } catch {
        return { url, html: null };
      }
    }));
    for (const { url, html } of fetched) {
      if (!html) continue;
      const identity = classifyToyshopStore(url);
      if (identity) rows.set(url, { url, ...identity, html, discoveryProvider: "official_store_graph" });
      for (const link of extractLinks(html, url)) enqueue(link);
    }
  }

  return [...rows.values()];
}

export async function discoverToyshopBranchUrls({
  fetchImpl = fetch,
  fallbackSeeds = TOYSHOP_STORE_FALLBACK_SEEDS,
  fallbackDiscoveryLimit = DEFAULT_TOYSHOP_FALLBACK_DISCOVERY_LIMIT,
  fallbackConcurrency = DEFAULT_TOYSHOP_FALLBACK_CONCURRENCY,
} = {}) {
  try {
    const xml = await fetchText("https://www.thetoyshop.com/sitemap/media/Store-en-GBP", { fetchImpl });
    const sitemapRows = extractSitemapUrls(xml)
      .map((url) => ({ url: canonicalToyshopStoreUrl(url) }))
      .filter((row) => row.url)
      .map((row) => ({ url: row.url, ...classifyToyshopStore(row.url), discoveryProvider: "official_store_sitemap" }))
      .filter((row) => row.retailerId);
    if (sitemapRows.length) return sitemapRows;
  } catch {}

  return crawlToyshopOfficialStoreGraph({
    fetchImpl,
    seeds: fallbackSeeds,
    discoveryLimit: fallbackDiscoveryLimit,
    concurrency: fallbackConcurrency,
  });
}

function asdaPathDepth(url) {
  return new URL(url).pathname.split("/").filter(Boolean).length;
}

export async function discoverAsdaBranchUrls({ fetchImpl = fetch } = {}) {
  const root = "https://storelocator.asda.com/directory";
  const rootHtml = await fetchText(root, { fetchImpl });
  const regionUrls = extractLinks(rootHtml, root)
    .filter((url) => new URL(url).hostname === "storelocator.asda.com")
    .filter((url) => asdaPathDepth(url) === 1 && new URL(url).pathname !== "/directory");
  const cityUrls = new Set();
  for (const regionUrl of regionUrls) {
    const html = await fetchText(regionUrl, { fetchImpl }).catch(() => "");
    for (const url of extractLinks(html, regionUrl)) {
      if (new URL(url).hostname !== "storelocator.asda.com") continue;
      if (asdaPathDepth(url) === 2) cityUrls.add(url);
    }
  }
  const branches = new Set();
  for (const cityUrl of cityUrls) {
    const html = await fetchText(cityUrl, { fetchImpl }).catch(() => "");
    for (const url of extractLinks(html, cityUrl)) {
      if (new URL(url).hostname !== "storelocator.asda.com") continue;
      if (asdaPathDepth(url) >= 3) branches.add(url);
    }
  }
  return [...branches].map((url) => ({ url, retailerId: "asda-uk", provider: "asda_official_directory" }));
}

async function knownProviderIds(store, providers) {
  if (typeof store?.listRetailerLocations === "function") {
    const rows = await store.listRetailerLocations({ limit: 10000 });
    return new Set((rows || []).filter((row) => providers.has(row.provider)).map((row) => `${row.provider}|${row.providerId ?? row.provider_id}`));
  }
  if (typeof store?.pool !== "function") return new Set();
  const pool = await store.pool();
  const { rows } = await pool.query(
    "SELECT provider,provider_id FROM fatedrop_retailer_locations WHERE provider = ANY($1::text[])",
    [[...providers]],
  );
  return new Set(rows.map((row) => `${row.provider}|${row.provider_id}`));
}

function asdaEligible(html, name) {
  const page = `${name} ${stripTags(html)}`.toLowerCase();
  if (page.includes("express petrol")) return false;
  return page.includes("supermarket") || page.includes("superstore") || page.includes("asda living") || page.includes("hypermarket");
}

export async function parseOfficialBranchPage(row, { fetchImpl = fetch } = {}) {
  const html = text(row?.html) ? String(row.html) : await fetchText(row.url, { fetchImpl });
  const structured = structuredLocation(html);
  const pageText = stripTags(html);
  const postcode = structured?.postcode || normalizePostcode(pageText);
  if (!postcode) return { location: null, reason: "postcode_missing" };
  const name = structured?.name || titleFromHtml(html, new URL(row.url).pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " "));
  if (row.retailerId === "asda-uk" && !asdaEligible(html, name)) {
    return { location: null, reason: "asda_non_tcg_store_format" };
  }
  let latitude = structured?.latitude;
  let longitude = structured?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const geocoded = await geocodeUkPostcode(postcode, { fetchImpl });
    latitude = geocoded?.latitude;
    longitude = geocoded?.longitude;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { location: null, reason: "coordinates_missing" };
  const identityUrl = new URL(row.url);
  identityUrl.search = "";
  identityUrl.hash = "";
  return {
    location: {
      retailerId: row.retailerId,
      provider: row.provider,
      providerId: identityUrl.toString().replace(/\/$/, ""),
      name,
      address: structured?.address,
      postcode,
      latitude,
      longitude,
      websiteUrl: identityUrl.toString().replace(/\/$/, ""),
      phone: structured?.phone,
      openingDetails: {
        sourceType: "official_retailer_branch_page",
        sourceUrl: identityUrl.toString().replace(/\/$/, ""),
        sourceAttribution: row.retailerId === "tesco-uk"
          ? "The Entertainer official Tesco stockist directory"
          : "The Entertainer official store directory",
        discoveryProvider: text(row.discoveryProvider) || null,
      },
      verification: "official_retailer_branch",
      updatedAt: Date.now(),
    },
    reason: null,
  };
}

async function persist(store, records) {
  const normalized = normalizeRetailerLocationBatch(records);
  if (!normalized.locations.length) return { saved: 0, rejected: normalized.rejected };
  const result = await upsertRetailerLocationsIntoStore(store, normalized.locations);
  return { saved: Number(result?.saved || 0), rejected: normalized.rejected };
}

export async function runNationalBranchDirectorySync({
  store,
  fetchImpl = fetch,
  branchFetchLimit = DEFAULT_BRANCH_FETCH_LIMIT,
  toyshopFallbackSeeds = TOYSHOP_STORE_FALLBACK_SEEDS,
  toyshopFallbackDiscoveryLimit = DEFAULT_TOYSHOP_FALLBACK_DISCOVERY_LIMIT,
  toyshopFallbackConcurrency = DEFAULT_TOYSHOP_FALLBACK_CONCURRENCY,
} = {}) {
  if (!store) throw new Error("National branch directory sync requires a store");
  const sourceResults = [];
  const discovered = [];
  for (const [source, discover, options] of [
    ["toyshop_official_store_directory", discoverToyshopBranchUrls, {
      fallbackSeeds: toyshopFallbackSeeds,
      fallbackDiscoveryLimit: toyshopFallbackDiscoveryLimit,
      fallbackConcurrency: toyshopFallbackConcurrency,
    }],
    ["asda_official_directory", discoverAsdaBranchUrls, {}],
  ]) {
    try {
      const rows = await discover({ fetchImpl, ...options });
      discovered.push(...rows);
      const discoveryProviders = [...new Set(rows.map((row) => text(row.discoveryProvider)).filter(Boolean))];
      sourceResults.push({ source, status: "ok", discovered: rows.length, discoveryProviders });
    } catch (error) {
      sourceResults.push({ source, status: "unavailable", discovered: 0, error: String(error?.message || error) });
    }
  }

  const unique = new Map();
  for (const row of discovered) unique.set(`${row.provider}|${row.url}`, row);
  const providers = new Set([...unique.values()].map((row) => row.provider));
  const known = await knownProviderIds(store, providers).catch(() => new Set());
  const pending = [...unique.values()]
    .filter((row) => !known.has(`${row.provider}|${new URL(row.url).toString().replace(/\/$/, "")}`))
    .slice(0, Math.max(1, Number(branchFetchLimit) || DEFAULT_BRANCH_FETCH_LIMIT));

  const accepted = [];
  const rejected = [];
  for (const row of pending) {
    try {
      const parsed = await parseOfficialBranchPage(row, { fetchImpl });
      if (parsed.location) accepted.push(parsed.location);
      else rejected.push({ url: row.url, retailerId: row.retailerId, reason: parsed.reason });
    } catch (error) {
      rejected.push({ url: row.url, retailerId: row.retailerId, reason: String(error?.message || error) });
    }
  }

  const saved = await persist(store, accepted);
  return {
    status: sourceResults.some((row) => row.status === "ok") ? "ok" : "unavailable",
    sources: sourceResults,
    discovered: unique.size,
    alreadyKnown: unique.size - pending.length,
    attempted: pending.length,
    accepted: accepted.length,
    saved: saved.saved,
    rejected: rejected.length + saved.rejected.length,
    rejectionSamples: [...rejected, ...saved.rejected].slice(0, 20),
    truthRule: "Branch-directory evidence establishes physical branch identity only. It never establishes Pokémon stock or Local Manifested.",
  };
}
