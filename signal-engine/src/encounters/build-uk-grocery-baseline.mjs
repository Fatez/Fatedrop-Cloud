import fs from "node:fs/promises";
import path from "node:path";

const USER_AGENT = "FateDrop-LocalRadar-GroceryBaseline/1.0 (+https://fatedrop.co.uk)";
const OUT = path.resolve(process.cwd(), "artifacts-grocery");
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const CHECKED_DATE = new Date().toISOString().slice(0, 10);

function normalizePostcode(value) {
  const match = String(value || "").toUpperCase().match(UK_POSTCODE_RE);
  if (!match) return null;
  const compact = match[1].replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function key(retailerId, postcode) {
  const pc = String(normalizePostcode(postcode) || "").replace(/\s+/g, "");
  return retailerId && pc ? `${retailerId}|${pc}` : "";
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows, headers) {
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
}

async function json(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function version(name) {
  const q = String(name).match(/(20\d{2})[_-]?Q([1-4])/i);
  if (q) return Number(q[1]) * 100 + Number(q[2]) * 3;
  const ymd = String(name).match(/(20\d{2})(0[1-9]|1[0-2])/);
  if (ymd) return Number(ymd[1]) * 100 + Number(ymd[2]);
  return 0;
}

async function latestService() {
  const root = await json("https://services8.arcgis.com/3ArZhpXFARDixnL2/ArcGIS/rest/services?f=json");
  const rows = (root.services || [])
    .filter((s) => /geolytix.*retail.*points|retail.*points.*geolytix/i.test(s.name || ""))
    .map((s) => ({ ...s, v: version(s.name) }))
    .sort((a, b) => b.v - a.v);
  if (!rows.length) throw new Error("No Geolytix Retail Points service found");
  const s = rows[0];
  return {
    name: s.name,
    url: `https://services8.arcgis.com/3ArZhpXFARDixnL2/ArcGIS/rest/services/${s.name}/FeatureServer/0`,
  };
}

async function allRows(serviceUrl) {
  const out = [];
  for (let offset = 0; offset < 50_000;) {
    const u = new URL(`${serviceUrl}/query`);
    u.searchParams.set("where", "1=1");
    u.searchParams.set("outFields", "*");
    u.searchParams.set("returnGeometry", "false");
    u.searchParams.set("resultOffset", String(offset));
    u.searchParams.set("resultRecordCount", "1000");
    u.searchParams.set("f", "json");
    const body = await json(u.toString());
    if (body.error) throw new Error(body.error.message || "ArcGIS query failed");
    const page = (body.features || []).map((f) => f.attributes || {});
    out.push(...page);
    if (!page.length || (page.length < 1000 && !body.exceededTransferLimit)) break;
    offset += page.length;
  }
  return out;
}

const RULES = [
  { retailer: "Aldi", id: "aldi-uk", include: /\baldi\b/i, exclude: /aldi local/i, eligibility: "LIKELY_TCG_RETAILER" },
  { retailer: "ASDA", id: "asda-uk", include: /\basda\b/i, exclude: /express|petrol|pfs|fuel/i, eligibility: "LIKELY_TCG_RETAILER" },
  { retailer: "Costco", id: "costco-uk", include: /\bcostco\b/i, exclude: /distribution|office/i, eligibility: "CONFIRMED_TCG_RETAILER" },
  { retailer: "Morrisons", id: "morrisons-uk", include: /\bmorrisons\b/i, exclude: /daily|mccoll|petrol|garage|market kitchen/i, eligibility: "LIKELY_TCG_RETAILER" },
  { retailer: "Sainsbury's", id: "sainsburys-uk", include: /sainsbury/i, exclude: /local|petrol/i, eligibility: "LIKELY_TCG_RETAILER" },
  { retailer: "Tesco", id: "tesco-uk", include: /\btesco\b/i, exclude: /express|petrol|pfs|shell|minishop/i, eligibility: "LIKELY_TCG_RETAILER" },
];

const HEADERS = [
  "Retailer","Canonical Retailer ID","Branch Name","Host Retailer","Store Relationship","Address","Town / City","County / Region","Postcode","Country","Latitude","Longitude","Store Format","Current Status","TCG Eligibility","TCG Evidence","Physical Stock Status","Stock Claim","Duplicate Key","Official / Dataset Source URL","Source Type","Source Checked Date","Source Freshness","Import Ready","Notes"
];

function convert(record, service) {
  const haystack = [record.retailer, record.fascia, record.store_name].filter(Boolean).join(" ");
  const rule = RULES.find((r) => r.include.test(haystack) && !r.exclude.test(haystack));
  if (!rule) return null;
  const postcode = normalizePostcode(record.postcode);
  const lat = Number(record.lat_wgs);
  const lon = Number(record.long_wgs);
  if (!postcode || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    "Retailer": rule.retailer,
    "Canonical Retailer ID": rule.id,
    "Branch Name": record.store_name || record.fascia || rule.retailer,
    "Host Retailer": "",
    "Store Relationship": rule.retailer === "Costco" ? "WAREHOUSE_CLUB" : "STANDALONE",
    "Address": [record.add_one, record.add_two].filter(Boolean).join(", "),
    "Town / City": record.town || record.suburb || "",
    "County / Region": record.county || "",
    "Postcode": postcode,
    "Country": "United Kingdom",
    "Latitude": lat,
    "Longitude": lon,
    "Store Format": record.fascia || record.size_band || "Retail store",
    "Current Status": "OPEN_BASELINE",
    "TCG Eligibility": rule.eligibility,
    "TCG Evidence": "Geolytix Retail Points physical branch identity; FateDrop retailer-level TCG relevance classification. Store existence does not assert stock.",
    "Physical Stock Status": "UNKNOWN",
    "Stock Claim": false,
    "Duplicate Key": key(rule.id, postcode),
    "Official / Dataset Source URL": service.url,
    "Source Type": "GEOLYTIX_RETAIL_POINTS",
    "Source Checked Date": CHECKED_DATE,
    "Source Freshness": service.name,
    "Import Ready": "YES",
    "Notes": "Physical location identity baseline. Current official branch data should override on the same retailer+postcode. Stock UNKNOWN.",
  };
}

async function main() {
  const service = await latestService();
  const source = await allRows(service.url);
  const candidates = source.map((r) => convert(r, service)).filter(Boolean);
  const byKey = new Map();
  const duplicates = [];
  for (const row of candidates) {
    if (!row["Duplicate Key"]) continue;
    if (byKey.has(row["Duplicate Key"])) duplicates.push(row["Duplicate Key"]);
    else byKey.set(row["Duplicate Key"], row);
  }
  const rows = [...byKey.values()].sort((a,b) => a.Retailer.localeCompare(b.Retailer) || a["Town / City"].localeCompare(b["Town / City"]));
  const counts = {};
  for (const row of rows) counts[row.Retailer] = (counts[row.Retailer] || 0) + 1;
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "grocery-baseline.csv"), csv(rows, HEADERS));
  await fs.writeFile(path.join(OUT, "grocery-baseline-qa.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), service, sourceRows: source.length, acceptedRows: rows.length,
    duplicatesRemoved: duplicates.length, retailerCounts: counts, neonTouched: false,
    stockPolicy: "UNKNOWN / no stock claim"
  }, null, 2) + "\n");
  console.log(JSON.stringify({ service, sourceRows: source.length, acceptedRows: rows.length, retailerCounts: counts, duplicatesRemoved: duplicates.length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
