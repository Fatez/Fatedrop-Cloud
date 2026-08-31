import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import {
  discoverAsdaBranchUrls,
  discoverToyshopBranchUrls,
  parseOfficialBranchPage,
} from "./national-branch-directory-sync.mjs";

const USER_AGENT = "FateDrop-LocalRadar-MasterBuilder/1.0 (+https://fatedrop.co.uk)";
const UK_POSTCODE_RE = /\b(GIR\s*0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const CHECKED_DATE = new Date().toISOString().slice(0, 10);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 8;
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts");

const BAD_LOCATION_RE = /\b(pharmacy|petrol(?: station)?|fuel station|distribution cent(?:re|er)|fulfilment cent(?:re|er)|head office|corporate office|warehouse only|depot)\b/i;
const CLOSED_RE = /\b(permanently closed|store closed permanently|this store is now closed|branch closed)\b/i;
const OPENING_RE = /\b(opening soon|coming soon|opens? on \d|new store opening)\b/i;

export function normalizePostcode(value) {
  const match = String(value || "").toUpperCase().match(UK_POSTCODE_RE);
  if (!match) return null;
  const compact = match[1].replace(/\s+/g, "");
  if (compact.length < 5 || compact.length > 7) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

export function compactPostcode(value) {
  return String(normalizePostcode(value) || "").replace(/\s+/g, "");
}

export function canonicalKey(retailerId, postcode) {
  const compact = compactPostcode(postcode);
  return retailerId && compact ? `${retailerId}|${compact}` : null;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, headers) {
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
}

async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml,text/xml,application/json;q=0.9,*/*;q=0.5",
        "user-agent": USER_AGENT,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options) {
  const body = await fetchText(url, options);
  return JSON.parse(body);
}

async function mapConcurrent(items, mapper, concurrency = DEFAULT_CONCURRENCY) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return output;
}

function stripTags(html) {
  return cheerio.load(String(html || "")).root().text().replace(/\s+/g, " ").trim();
}

function jsonLdObjects(html) {
  const $ = cheerio.load(String(html || ""));
  const rows = [];
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const value = JSON.parse(raw);
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        rows.push(node);
        for (const child of Object.values(node)) {
          if (child && typeof child === "object") walk(child);
        }
      };
      walk(value);
    } catch {}
  });
  return rows;
}

function structuredLocation(html) {
  for (const row of jsonLdObjects(html)) {
    const address = row?.address && typeof row.address === "object" ? row.address : null;
    const postcode = normalizePostcode(address?.postalCode || address?.postal_code);
    if (!postcode) continue;
    const geo = row?.geo && typeof row.geo === "object" ? row.geo : null;
    const latitude = Number(geo?.latitude ?? row?.latitude);
    const longitude = Number(geo?.longitude ?? row?.longitude);
    const street = [address?.streetAddress, address?.addressLocality, address?.addressRegion]
      .filter(Boolean).map((v) => String(v).trim()).join(", ");
    return {
      name: row?.name ? String(row.name).trim() : null,
      address: street || null,
      town: address?.addressLocality ? String(address.addressLocality).trim() : null,
      region: address?.addressRegion ? String(address.addressRegion).trim() : null,
      postcode,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
    };
  }
  return null;
}

function pageTitle(html, fallback = "Retail store") {
  const $ = cheerio.load(String(html || ""));
  return ($("h1").first().text() || $("title").first().text() || fallback)
    .replace(/\s+/g, " ").replace(/\s*[|–-]\s*[^|–-]+$/g, "").trim() || fallback;
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(String(html || ""));
  const output = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) return;
      url.hash = "";
      output.add(url.toString());
    } catch {}
  });
  return [...output];
}

function extractSitemapUrls(xml) {
  const output = [];
  for (const match of String(xml || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    try { output.push(new URL(match[1].replace(/&amp;/g, "&").trim()).toString()); } catch {}
  }
  return [...new Set(output)];
}

async function discoverSitemapSeeds(origin) {
  const output = new Set();
  try {
    const robots = await fetchText(new URL("/robots.txt", origin));
    for (const match of robots.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)) output.add(match[1]);
  } catch {}
  output.add(new URL("/sitemap.xml", origin).toString());
  return [...output];
}

async function discoverStoreUrlsFromSitemaps(config) {
  const seeds = await discoverSitemapSeeds(config.origin);
  const queue = [...seeds];
  const visited = new Set();
  const stores = new Set();
  const maxSitemaps = config.maxSitemaps ?? 80;

  while (queue.length && visited.size < maxSitemaps) {
    const sitemap = queue.shift();
    if (!sitemap || visited.has(sitemap)) continue;
    visited.add(sitemap);
    let body;
    try { body = await fetchText(sitemap, { timeoutMs: 20_000 }); } catch { continue; }
    const urls = extractSitemapUrls(body);
    const isIndex = /<sitemapindex\b/i.test(body);
    if (isIndex) {
      for (const url of urls) {
        if (queue.length + visited.size >= maxSitemaps) break;
        if (!visited.has(url)) queue.push(url);
      }
    } else {
      for (const url of urls) if (config.storeUrl.test(url)) stores.add(url);
    }
  }
  return [...stores];
}

async function discoverStoreUrlsFromDirectories(config) {
  const stores = new Set();
  const visited = new Set();
  const queue = [...config.directoryUrls];
  const maxPages = config.maxDirectoryPages ?? 120;
  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    let html;
    try { html = await fetchText(url); } catch { continue; }
    for (const link of extractLinks(html, url)) {
      if (config.storeUrl.test(link)) {
        stores.add(link);
        continue;
      }
      let parsed;
      try { parsed = new URL(link); } catch { continue; }
      const origin = new URL(config.origin);
      if (parsed.hostname !== origin.hostname) continue;
      if (config.directoryUrl?.test(link) && !visited.has(link)) queue.push(link);
    }
  }
  return [...stores];
}

async function geocode(postcode) {
  const normalized = normalizePostcode(postcode);
  if (!normalized) return null;
  try {
    const body = await fetchJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(normalized)}`);
    const latitude = Number(body?.result?.latitude);
    const longitude = Number(body?.result?.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  } catch { return null; }
}

function genericExclusionReason(config, html, name) {
  const text = `${name || ""} ${stripTags(html)}`;
  if (CLOSED_RE.test(text)) return "closed";
  if (OPENING_RE.test(text)) return "opening_soon";
  if (BAD_LOCATION_RE.test(name || "")) return "non_retail_or_excluded_format";
  if (config.exclude?.test(text)) return "retailer_format_excluded";
  return null;
}

async function parseGenericStorePage(config, url) {
  let html;
  try { html = await fetchText(url); } catch (error) {
    return { location: null, reason: `fetch_failed:${error.message}`, url };
  }
  const structured = structuredLocation(html);
  const text = stripTags(html);
  const postcode = structured?.postcode || normalizePostcode(text);
  const name = structured?.name || pageTitle(html, config.retailer);
  const excluded = genericExclusionReason(config, html, name);
  if (excluded) return { location: null, reason: excluded, url };
  if (!postcode) return { location: null, reason: "postcode_missing", url };

  let latitude = structured?.latitude;
  let longitude = structured?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const point = await geocode(postcode);
    latitude = point?.latitude;
    longitude = point?.longitude;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { location: null, reason: "coordinates_missing", url };
  }

  return {
    location: makeMasterRow({
      retailer: config.retailer,
      retailerId: config.retailerId,
      branch: name,
      hostRetailer: config.hostRetailer || "",
      relationship: config.relationship || "STANDALONE",
      address: structured?.address || "",
      town: structured?.town || "",
      region: structured?.region || "",
      postcode,
      latitude,
      longitude,
      storeFormat: config.storeFormat || "Retail store",
      currentStatus: "OPEN",
      tcgEligibility: config.tcgEligibility,
      evidence: config.evidence,
      sourceType: "OFFICIAL_BRANCH_PAGE",
      sourceUrl: url,
      sourceFreshness: "CURRENT_OFFICIAL",
      importReady: "YES",
      notes: config.notes || "",
    }),
    reason: null,
  };
}

export function makeMasterRow(input) {
  const postcode = normalizePostcode(input.postcode);
  const eligibility = input.tcgEligibility || "LIKELY_TCG_RETAILER";
  const sellerStatus = eligibility === "OFFICIAL_POKEMON_RETAILER"
    ? "RETAILER_VERIFIED_BRANCH_UNCONFIRMED"
    : eligibility === "CONFIRMED_TCG_RETAILER"
      ? "RETAILER_CONFIRMED_BRANCH_UNCONFIRMED"
      : "RETAILER_LIKELY_BRANCH_UNCONFIRMED";
  return {
    "Retailer": input.retailer,
    "Canonical Retailer ID": input.retailerId,
    "Branch Name": input.branch,
    "Host Retailer": input.hostRetailer || "",
    "Store Relationship": input.relationship || "STANDALONE",
    "Address": input.address || "",
    "Town / City": input.town || "",
    "County / Region": input.region || "",
    "Postcode": postcode || "",
    "Country": "United Kingdom",
    "Latitude": input.latitude ?? "",
    "Longitude": input.longitude ?? "",
    "Store Format": input.storeFormat || "Retail store",
    "Current Status": input.currentStatus || "OPEN",
    "TCG Eligibility": eligibility,
    "TCG Evidence": input.evidence || "",
    "Branch Identity Status": input.identityStatus || "SOURCE_VERIFIED",
    "Pokémon Seller Status": input.pokemonSellerStatus || sellerStatus,
    "Physical Stock Status": "UNKNOWN",
    "Stock Claim": false,
    "Duplicate Key": canonicalKey(input.retailerId, postcode) || "",
    "Official / Dataset Source URL": input.sourceUrl || "",
    "Source Type": input.sourceType || "",
    "Source Checked Date": CHECKED_DATE,
    "Source Freshness": input.sourceFreshness || "",
    "Import Ready": input.importReady || "NO",
    "Import Scope": "BRANCH_IDENTITY_ONLY",
    "Conflict Status": "CLEAR",
    "Notes": input.notes || "",
  };
}

function masterRowDistanceMiles(a, b) {
  const latitudeA = Number(a.Latitude);
  const longitudeA = Number(a.Longitude);
  const latitudeB = Number(b.Latitude);
  const longitudeB = Number(b.Longitude);
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(latitudeB - latitudeA);
  const dLon = toRad(longitudeB - longitudeA);
  const lat1 = toRad(latitudeA);
  const lat2 = toRad(latitudeB);
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function dedupeMasterRows(rows) {
  const output = new Map();
  const duplicates = [];
  const conflicts = [];
  const blocked = new Set();
  for (const row of rows) {
    const key = row["Duplicate Key"];
    if (!key) continue;
    if (blocked.has(key)) {
      conflicts.find((item) => item.key === key)?.candidates.push(row);
      continue;
    }
    const previous = output.get(key);
    if (!previous) {
      output.set(key, row);
      continue;
    }
    const distance = masterRowDistanceMiles(previous, row);
    if (distance == null || distance > 1) {
      output.delete(key);
      blocked.add(key);
      conflicts.push({
        key,
        reason: distance == null ? "duplicate_key_coordinates_missing" : "duplicate_key_coordinate_conflict",
        distanceMiles: distance == null ? null : Number(distance.toFixed(3)),
        candidates: [previous, row],
      });
      continue;
    }
    const previousOfficial = previous["Source Freshness"] === "CURRENT_OFFICIAL";
    const currentOfficial = row["Source Freshness"] === "CURRENT_OFFICIAL";
    if (currentOfficial && !previousOfficial) {
      duplicates.push({ kept: row, rejected: previous, reason: "official_source_preferred" });
      output.set(key, row);
    } else {
      duplicates.push({ kept: previous, rejected: row, reason: "duplicate_retailer_postcode" });
    }
  }
  return { rows: [...output.values()], duplicates, conflicts };
}

function parseGeolytixVersion(name) {
  const q = name.match(/(20\d{2})[_-]?Q([1-4])/i);
  if (q) return Number(q[1]) * 100 + Number(q[2]) * 3;
  const ymd = name.match(/(20\d{2})(0[1-9]|1[0-2])/);
  if (ymd) return Number(ymd[1]) * 100 + Number(ymd[2]);
  return 0;
}

async function latestGeolytixService() {
  const root = "https://services8.arcgis.com/3ArZhpXFARDixnL2/ArcGIS/rest/services?f=json";
  const body = await fetchJson(root);
  const candidates = (body?.services || [])
    .filter((row) => /geolytix.*retail.*points|retail.*points.*geolytix/i.test(row.name || ""))
    .map((row) => ({ ...row, version: parseGeolytixVersion(row.name || "") }))
    .sort((a, b) => b.version - a.version);
  const chosen = candidates[0];
  if (!chosen) throw new Error("No Geolytix Retail Points ArcGIS service found");
  return {
    name: chosen.name,
    version: chosen.version,
    url: `https://services8.arcgis.com/3ArZhpXFARDixnL2/ArcGIS/rest/services/${encodeURIComponent(chosen.name).replace(/%2F/g, "/")}/FeatureServer/0`,
  };
}

async function queryArcGisAll(serviceUrl) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const query = new URL(`${serviceUrl}/query`);
    query.searchParams.set("where", "1=1");
    query.searchParams.set("outFields", "*");
    query.searchParams.set("returnGeometry", "false");
    query.searchParams.set("resultOffset", String(offset));
    query.searchParams.set("resultRecordCount", String(pageSize));
    query.searchParams.set("f", "json");
    const body = await fetchJson(query.toString(), { timeoutMs: 30_000 });
    if (body?.error) throw new Error(body.error.message || "ArcGIS query failed");
    const page = (body?.features || []).map((feature) => feature.attributes || {});
    rows.push(...page);
    if (page.length < pageSize && !body?.exceededTransferLimit) break;
    offset += page.length;
    if (!page.length || offset > 50_000) break;
  }
  return rows;
}

const GROCERY_RULES = [
  {
    retailer: "Aldi", retailerId: "aldi-uk", tcgEligibility: "LIKELY_TCG_RETAILER",
    match: (s) => /\baldi\b/i.test(s), exclude: /aldi local/i,
    evidence: "Geolytix Retail Points physical branch identity; FateDrop chain-level Pokémon TCG relevance research.",
  },
  {
    retailer: "ASDA", retailerId: "asda-uk", tcgEligibility: "LIKELY_TCG_RETAILER",
    match: (s) => /\basda\b/i.test(s), exclude: /express|petrol|pfs|fuel/i,
    evidence: "Geolytix Retail Points identity; full-size ASDA formats only. Current official ASDA directory is additionally crawled.",
  },
  {
    retailer: "Costco", retailerId: "costco-uk", tcgEligibility: "CONFIRMED_TCG_RETAILER",
    match: (s) => /\bcostco\b/i.test(s), exclude: /distribution|office/i,
    evidence: "Geolytix Retail Points customer warehouse identity; Costco UK has documented Pokémon TCG retail activity.",
  },
  {
    retailer: "Morrisons", retailerId: "morrisons-uk", tcgEligibility: "LIKELY_TCG_RETAILER",
    match: (s) => /\bmorrisons\b/i.test(s), exclude: /daily|mccoll|petrol|garage|market kitchen/i,
    evidence: "Geolytix Retail Points full supermarket identity; convenience/petrol formats excluded.",
  },
  {
    retailer: "Sainsbury's", retailerId: "sainsburys-uk", tcgEligibility: "LIKELY_TCG_RETAILER",
    match: (s) => /sainsbury/i.test(s), exclude: /local|petrol/i,
    evidence: "Geolytix Retail Points full supermarket identity; Local/convenience formats excluded by default.",
  },
  {
    retailer: "Tesco", retailerId: "tesco-uk", tcgEligibility: "LIKELY_TCG_RETAILER",
    match: (s) => /\btesco\b/i.test(s), exclude: /express|petrol|pfs|shell|minishop/i,
    evidence: "Geolytix Retail Points substantial Tesco branch identity; Express/petrol formats excluded by default.",
  },
];

function geolytixRowToMaster(record, service) {
  const search = [record.retailer, record.fascia, record.store_name].filter(Boolean).join(" ");
  const rule = GROCERY_RULES.find((candidate) => candidate.match(search) && !candidate.exclude?.test(search));
  if (!rule) return null;
  const postcode = normalizePostcode(record.postcode);
  const latitude = Number(record.lat_wgs);
  const longitude = Number(record.long_wgs);
  if (!postcode || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const address = [record.add_one, record.add_two].filter(Boolean).join(", ");
  return makeMasterRow({
    retailer: rule.retailer,
    retailerId: rule.retailerId,
    branch: record.store_name || record.fascia || rule.retailer,
    relationship: rule.retailer === "Costco" ? "WAREHOUSE_CLUB" : "STANDALONE",
    address,
    town: record.town || record.suburb || "",
    region: record.county || "",
    postcode,
    latitude,
    longitude,
    storeFormat: record.fascia || record.size_band || "Retail store",
    currentStatus: "OPEN_BASELINE",
    tcgEligibility: rule.tcgEligibility,
    evidence: rule.evidence,
    sourceType: "GEOLYTIX_RETAIL_POINTS",
    sourceUrl: service.url,
    sourceFreshness: `GEOLYTIX_${service.name}`,
    importReady: "YES",
    notes: "Physical branch identity only. Stock UNKNOWN. Current official locator data overrides this row on duplicate retailer+postcode.",
  });
}

const DIRECTORY_CONFIGS = [
  {
    retailer: "Smyths Toys", retailerId: "smyths-uk", origin: "https://www.smythstoys.com",
    directoryUrls: ["https://www.smythstoys.com/uk/en-gb/storefinder"],
    storeUrl: /smythstoys\.com\/uk\/en-gb\/storefinder\/storedetails\/[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /smythstoys\.com\/uk\/en-gb\/storefinder/i,
    tcgEligibility: "OFFICIAL_POKEMON_RETAILER", evidence: "Official Smyths current store page; major Pokémon TCG retailer.",
  },
  {
    retailer: "Hobbycraft", retailerId: "hobbycraft-uk", origin: "https://www.hobbycraft.co.uk",
    directoryUrls: ["https://www.hobbycraft.co.uk/storelist/"],
    storeUrl: /hobbycraft\.co\.uk\/stores\/[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /hobbycraft\.co\.uk\/(?:storelist|stores)/i,
    tcgEligibility: "CONFIRMED_TCG_RETAILER", evidence: "Official Hobbycraft store page + current trading-card/Pokémon category.",
  },
  {
    retailer: "Ryman", retailerId: "ryman-uk", origin: "https://www.ryman.co.uk",
    directoryUrls: ["https://www.ryman.co.uk/storefinder/"],
    storeUrl: /ryman\.co\.uk\/storefinder\/(?!\?)(?:ryman-)?[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /ryman\.co\.uk\/storefinder/i,
    tcgEligibility: "OFFICIAL_POKEMON_RETAILER", evidence: "Official Ryman storefinder branch + Pokémon TCG retail evidence.",
  },
  {
    retailer: "TGJones", retailerId: "tgjones-uk", origin: "https://www.tgjonesonline.co.uk",
    directoryUrls: ["https://www.tgjonesonline.co.uk/storelocator/"],
    storeUrl: /tgjonesonline\.co\.uk\/stores\/[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /tgjonesonline\.co\.uk\/(?:storelocator|stores)/i,
    tcgEligibility: "OFFICIAL_POKEMON_RETAILER", evidence: "Current TGJones official branch identity; former WHSmith High Street estate kept separate from WHSmith Travel.",
  },
  {
    retailer: "Forbidden Planet", retailerId: "forbidden-planet-uk", origin: "https://forbiddenplanet.com",
    directoryUrls: ["https://forbiddenplanet.com/stores/"],
    storeUrl: /forbiddenplanet\.com\/stores\/[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /forbiddenplanet\.com\/stores/i,
    tcgEligibility: "OFFICIAL_POKEMON_RETAILER", evidence: "Official Forbidden Planet store page; specialist TCG/pop-culture retailer.",
  },
  {
    retailer: "HMV", retailerId: "hmv-uk", origin: "https://hmv.com",
    directoryUrls: ["https://hmv.com/store-finder"],
    storeUrl: /hmv\.com\/store-finder\/hmv-[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /hmv\.com\/store-finder/i,
    tcgEligibility: "OFFICIAL_POKEMON_RETAILER", evidence: "Official HMV store finder branch; HMV is an official Pokémon promotional retailer.",
  },
  {
    retailer: "Waterstones", retailerId: "waterstones-uk", origin: "https://www.waterstones.com",
    directoryUrls: ["https://www.waterstones.com/bookshops/viewall", "https://www.waterstones.com/bookshops/viewall/page/2", "https://www.waterstones.com/bookshops/viewall/page/3", "https://www.waterstones.com/bookshops/viewall/page/4", "https://www.waterstones.com/bookshops/viewall/page/5", "https://www.waterstones.com/bookshops/viewall/page/6", "https://www.waterstones.com/bookshops/viewall/page/7", "https://www.waterstones.com/bookshops/viewall/page/8", "https://www.waterstones.com/bookshops/viewall/page/9", "https://www.waterstones.com/bookshops/viewall/page/10", "https://www.waterstones.com/bookshops/viewall/page/11", "https://www.waterstones.com/bookshops/viewall/page/12", "https://www.waterstones.com/bookshops/viewall/page/13", "https://www.waterstones.com/bookshops/viewall/page/14", "https://www.waterstones.com/bookshops/viewall/page/15", "https://www.waterstones.com/bookshops/viewall/page/16"],
    storeUrl: /waterstones\.com\/bookshops\/(?!viewall(?:\/|\?|$))[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /waterstones\.com\/bookshops/i,
    tcgEligibility: "OFFICIAL_POKEMON_RETAILER", evidence: "Official Waterstones bookshop page; Waterstones is named in official Pokémon retail campaigns.",
  },
  {
    retailer: "Menkind", retailerId: "menkind-uk", origin: "https://stores.menkind.co.uk",
    directoryUrls: ["https://stores.menkind.co.uk/"],
    storeUrl: /stores\.menkind\.co\.uk\/(?:l|store)\/[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /stores\.menkind\.co\.uk\//i,
    tcgEligibility: "CONFIRMED_TCG_RETAILER", evidence: "Official Menkind physical-store locator; Menkind sells Pokémon cards in-store.",
  },
  {
    retailer: "The Works", retailerId: "the-works-uk", origin: "https://www.theworks.co.uk",
    directoryUrls: ["https://www.theworks.co.uk/stores?horizontalView=true&showMap=true"],
    storeUrl: /theworks\.co\.uk\/stores\/[a-z0-9-]+\/?(?:\?|$)/i,
    directoryUrl: /theworks\.co\.uk\/stores/i,
    tcgEligibility: "CONFIRMED_TCG_RETAILER", evidence: "Official The Works store locator + current Pokémon TCG catalogue.",
  },
  {
    retailer: "B&M", retailerId: "bm-stores-uk", origin: "https://www.bmstores.co.uk",
    directoryUrls: ["https://www.bmstores.co.uk/stores"],
    storeUrl: /bmstores\.co\.uk\/stores\/[a-z0-9-]+(?:-[a-z0-9-]+)?\/?(?:\?|$)/i,
    directoryUrl: /bmstores\.co\.uk\/stores/i,
    tcgEligibility: "LIKELY_TCG_RETAILER", evidence: "Official B&M branch directory; branch identity only, Pokémon availability varies.",
  },
];

async function collectDirectoryRetailer(config, qa) {
  const [sitemapUrls, directoryUrls] = await Promise.all([
    discoverStoreUrlsFromSitemaps(config).catch((error) => { qa.sourceErrors.push({ retailer: config.retailer, source: "sitemap", error: error.message }); return []; }),
    discoverStoreUrlsFromDirectories(config).catch((error) => { qa.sourceErrors.push({ retailer: config.retailer, source: "directory", error: error.message }); return []; }),
  ]);
  const urls = [...new Set([...sitemapUrls, ...directoryUrls])];
  qa.discovery.push({ retailer: config.retailer, candidates: urls.length, source: "official_directory+sitemap" });
  const parsed = await mapConcurrent(urls, (url) => parseGenericStorePage(config, url), config.concurrency || DEFAULT_CONCURRENCY);
  const output = [];
  for (const result of parsed) {
    if (result?.location) output.push(result.location);
    else qa.rejections.push({ retailer: config.retailer, url: result?.url || "", reason: result?.reason || "unknown" });
  }
  return output;
}

async function collectExistingOfficialCrawlers(qa) {
  const rows = [];
  try {
    const toyshop = await discoverToyshopBranchUrls({ fallbackDiscoveryLimit: 250, fallbackConcurrency: 10 });
    qa.discovery.push({ retailer: "The Entertainer / Tesco stockists", candidates: toyshop.length, source: "existing_official_crawler" });
    const parsed = await mapConcurrent(toyshop, (row) => parseOfficialBranchPage(row), 8);
    for (let i = 0; i < parsed.length; i++) {
      const result = parsed[i];
      const source = toyshop[i];
      if (!result?.location) {
        qa.rejections.push({ retailer: source?.retailerId || "toyshop", url: source?.url || "", reason: result?.reason || "unknown" });
        continue;
      }
      const loc = result.location;
      const isTesco = loc.retailerId === "tesco-uk";
      rows.push(makeMasterRow({
        retailer: isTesco ? "Tesco" : "The Entertainer",
        retailerId: loc.retailerId,
        branch: loc.name,
        hostRetailer: isTesco ? "Tesco" : "",
        relationship: isTesco ? "SHOP_IN_SHOP" : "STANDALONE",
        address: loc.address,
        postcode: loc.postcode,
        latitude: loc.latitude,
        longitude: loc.longitude,
        currentStatus: "OPEN",
        tcgEligibility: "OFFICIAL_POKEMON_RETAILER",
        evidence: isTesco ? "Official The Entertainer Tesco stockist branch page." : "Official The Entertainer branch page.",
        sourceType: "CURRENT_OFFICIAL_BRANCH_PAGE",
        sourceUrl: loc.websiteUrl,
        sourceFreshness: "CURRENT_OFFICIAL",
        importReady: "YES",
        notes: isTesco ? "The Entertainer/Toyshop relationship inside Tesco preserved; stock UNKNOWN." : "Stock UNKNOWN.",
      }));
    }
  } catch (error) {
    qa.sourceErrors.push({ retailer: "The Entertainer / Tesco stockists", source: "existing_official_crawler", error: error.message });
  }

  try {
    const asda = await discoverAsdaBranchUrls();
    qa.discovery.push({ retailer: "ASDA", candidates: asda.length, source: "existing_official_crawler" });
    const parsed = await mapConcurrent(asda, (row) => parseOfficialBranchPage(row), 8);
    for (let i = 0; i < parsed.length; i++) {
      const result = parsed[i];
      if (!result?.location) {
        qa.rejections.push({ retailer: "ASDA", url: asda[i]?.url || "", reason: result?.reason || "unknown" });
        continue;
      }
      const loc = result.location;
      rows.push(makeMasterRow({
        retailer: "ASDA", retailerId: "asda-uk", branch: loc.name,
        address: loc.address, postcode: loc.postcode, latitude: loc.latitude, longitude: loc.longitude,
        currentStatus: "OPEN", tcgEligibility: "LIKELY_TCG_RETAILER",
        evidence: "Current official ASDA branch directory; eligible full-store formats only.",
        sourceType: "CURRENT_OFFICIAL_BRANCH_PAGE", sourceUrl: loc.websiteUrl,
        sourceFreshness: "CURRENT_OFFICIAL", importReady: "YES", notes: "Express Petrol excluded; stock UNKNOWN.",
      }));
    }
  } catch (error) {
    qa.sourceErrors.push({ retailer: "ASDA", source: "existing_official_crawler", error: error.message });
  }
  return rows;
}

async function collectGeolytix(qa) {
  try {
    const service = await latestGeolytixService();
    qa.geolytix = { service: service.name, url: service.url };
    const sourceRows = await queryArcGisAll(service.url);
    qa.geolytix.sourceRows = sourceRows.length;
    const rows = sourceRows.map((row) => geolytixRowToMaster(row, service)).filter(Boolean);
    qa.geolytix.acceptedCandidateRows = rows.length;
    return rows;
  } catch (error) {
    qa.sourceErrors.push({ retailer: "Grocery baseline", source: "Geolytix ArcGIS", error: error.message });
    return [];
  }
}

const HEADERS = [
  "Retailer", "Canonical Retailer ID", "Branch Name", "Host Retailer", "Store Relationship",
  "Address", "Town / City", "County / Region", "Postcode", "Country", "Latitude", "Longitude",
  "Store Format", "Current Status", "TCG Eligibility", "TCG Evidence", "Branch Identity Status", "Pokémon Seller Status", "Physical Stock Status",
  "Stock Claim", "Duplicate Key", "Official / Dataset Source URL", "Source Type", "Source Checked Date",
  "Source Freshness", "Import Ready", "Import Scope", "Conflict Status", "Notes",
];

async function main() {
  const qa = {
    generatedAt: new Date().toISOString(),
    policy: {
      neonTouched: false,
      stockTruth: "UNKNOWN",
      dedupe: "canonical retailer id + normalized postcode",
      generatedLocationsAllowed: false,
    },
    geolytix: null,
    discovery: [],
    rejections: [],
    sourceErrors: [],
    duplicates: [],
    conflicts: [],
    coverage: [],
  };

  const all = [];
  const geolytix = await collectGeolytix(qa);
  all.push(...geolytix);

  const officialExisting = await collectExistingOfficialCrawlers(qa);
  all.push(...officialExisting);

  for (const config of DIRECTORY_CONFIGS) {
    const rows = await collectDirectoryRetailer(config, qa);
    all.push(...rows);
  }

  const { rows, duplicates, conflicts } = dedupeMasterRows(all);
  qa.duplicates = duplicates.map((item) => ({
    key: item.rejected["Duplicate Key"],
    keptSource: item.kept["Source Type"],
    rejectedSource: item.rejected["Source Type"],
    reason: item.reason,
  }));
  qa.conflicts = conflicts.map((item) => ({
    key: item.key,
    reason: item.reason,
    distanceMiles: item.distanceMiles,
    candidates: item.candidates.map((row) => ({
      branch: row["Branch Name"],
      postcode: row.Postcode,
      latitude: row.Latitude,
      longitude: row.Longitude,
      sourceType: row["Source Type"],
      sourceUrl: row["Official / Dataset Source URL"],
    })),
  }));

  const retailerCounts = new Map();
  for (const row of rows) {
    const name = row.Retailer;
    retailerCounts.set(name, (retailerCounts.get(name) || 0) + 1);
  }
  qa.coverage = [...retailerCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([retailer, count]) => ({ retailer, importReadyRows: count }));

  rows.sort((a, b) => a.Retailer.localeCompare(b.Retailer) || a["Town / City"].localeCompare(b["Town / City"]) || a.Postcode.localeCompare(b.Postcode));
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, "uk-physical-store-master.csv"), toCsv(rows, HEADERS));
  await fs.writeFile(path.join(OUTPUT_DIR, "uk-physical-store-qa.json"), JSON.stringify(qa, null, 2) + "\n");
  await fs.writeFile(path.join(OUTPUT_DIR, "uk-physical-store-retailer-summary.csv"), toCsv(
    qa.coverage.map((row) => ({ Retailer: row.retailer, "Import Ready Rows": row.importReadyRows })),
    ["Retailer", "Import Ready Rows"],
  ));

  console.log(JSON.stringify({
    outputRows: rows.length,
    retailers: qa.coverage.length,
    duplicatesRemoved: qa.duplicates.length,
    conflictsQuarantined: qa.conflicts.length,
    rejected: qa.rejections.length,
    sourceErrors: qa.sourceErrors,
    geolytix: qa.geolytix,
  }, null, 2));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry && import.meta.url === entry) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
