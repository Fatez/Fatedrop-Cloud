import { load } from "cheerio";
import { Pool } from "pg";
import { compareProductIdentity } from "../core/product-identity.mjs";

const COLLECTION_URL = "https://www.asmodee.co.uk/collections/all-pokemon-games?display=list";
const SOURCE = "asmodee-uk";

function normalizeBarcode(value = "") {
  return String(value).replace(/\D+/g, "");
}

function parseMoneyToPence(value = "") {
  const match = String(value).replace(/,/g, "").match(/£\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

export function parseAsmodeeProductPage(html, url = "") {
  const $ = load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() || $("title").text().split("–")[0].trim();
  const sku = bodyText.match(/Product Code \(SKU\):\s*([^|]+?)(?=\s*\|\s*Barcode:|\s*\|\s*RRP:|\s+Barcode:|\s+RRP:|\s+Description|$)/i)?.[1]?.trim() || null;
  const barcode = normalizeBarcode(bodyText.match(/Barcode:\s*([0-9\s-]{8,20})/i)?.[1] || "") || null;
  const unitRrpMatch = bodyText.match(/RRP:\s*(\d+)\s+units?\s+at\s+(£\s*[0-9]+(?:\.[0-9]{1,2})?)/i);
  const directRrpMatch = bodyText.match(/RRP:\s*(£\s*[0-9]+(?:\.[0-9]{1,2})?)/i);
  const rrpText = unitRrpMatch?.[2] || directRrpMatch?.[1] || "";
  const officialRrpPence = parseMoneyToPence(rrpText);
  const rrpUnitCount = unitRrpMatch ? Number.parseInt(unitRrpMatch[1], 10) : null;
  const publisher = bodyText.match(/Publisher:\s*([^|]+?)(?=\s+Subcategory:|\s+Family:|\s+Age Range:|\s+Publisher Release Date:|$)/i)?.[1]?.trim() || null;
  return { title, sku, barcode, officialRrpPence, rrpUnitCount, publisher, sourceUrl: url };
}

export function parseAsmodeeCollectionProductUrls(html, baseUrl = COLLECTION_URL) {
  const $ = load(html);
  const urls = new Set();
  $('a[href^="/products/"]').each((_, node) => {
    const href = $(node).attr("href");
    if (!href) return;
    try { urls.add(new URL(href.split("?")[0], baseUrl).toString()); } catch { /* ignore malformed */ }
  });
  return [...urls];
}

async function fetchText(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { "user-agent": "FateDrop-RRP/1.0 (+https://fatedrop.co.uk)" } });
  if (!response.ok) throw new Error(`Asmodee request failed ${response.status} for ${url}`);
  return response.text();
}

export async function collectAsmodeeRrpRecords({ fetchImpl = fetch, maxPages = 8, concurrency = 4 } = {}) {
  const productUrls = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${COLLECTION_URL}&page=${page}`;
    const html = await fetchText(url, fetchImpl);
    const pageUrls = parseAsmodeeCollectionProductUrls(html, url);
    for (const productUrl of pageUrls) productUrls.add(productUrl);
    if (page > 1 && pageUrls.length === 0) break;
  }

  const urls = [...productUrls];
  const records = [];
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const index = cursor++;
      const url = urls[index];
      try {
        const html = await fetchText(url, fetchImpl);
        const record = parseAsmodeeProductPage(html, url);
        if (!/^Pok[eé]mon TCG:/i.test(record.title)) continue;
        if (!/Pok[eé]mon Company/i.test(record.publisher || "")) continue;
        if (!Number.isFinite(record.officialRrpPence) || record.officialRrpPence <= 0) continue;
        records.push(record);
      } catch (error) {
        records.push({ sourceUrl: url, error: String(error?.message || error) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, () => worker()));
  return { discovered: urls.length, records: records.filter((x) => !x.error), errors: records.filter((x) => x.error) };
}

function normalizeAsmodeeIdentityTitle(record = {}) {
  let title = String(record.title || "").replace(/\s*\(1\)\s*$/, "").trim();
  const unitCount = Number.isInteger(record.rrpUnitCount) && record.rrpUnitCount > 1
    ? record.rrpUnitCount
    : null;

  if (unitCount && /\bCDU\s*\(\d+\)\s*$/i.test(title)) {
    const distributorQuantity = Number.parseInt(title.match(/\((\d+)\)\s*$/)?.[1] || "", 10);
    if (distributorQuantity === unitCount) title = title.replace(/\s*\(\d+\)\s*$/, "").trim();
  }

  // Asmodee's Pokémon "Booster CDU" / "Booster Display CDU" pages publish
  // a per-unit RRP (for example, "36 units at £4.29"). That unit is one
  // booster pack, not a consumer booster display. Only apply this rewrite
  // when the page explicitly supplied a multi-unit RRP line.
  if (unitCount && /\bbooster(?:\s+display)?\s+cdu\s*$/i.test(title)) {
    return title.replace(/\bbooster(?:\s+display)?\s+cdu\s*$/i, "Booster Pack").trim();
  }

  // Other CDU pages also publish the RRP per consumer unit. Removing only
  // the distributor-only CDU suffix preserves the actual product identity
  // (for example, Booster Bundle remains Booster Bundle).
  if (unitCount && /\bcdu\s*$/i.test(title)) title = title.replace(/\s+cdu\s*$/i, "").trim();
  return title;
}

export function chooseCanonicalMatch(record, products, offersByGtin) {
  if (record.barcode) {
    const ids = new Set((offersByGtin.get(record.barcode) || []).map((offer) => offer.product_id).filter(Boolean));
    if (ids.size === 1) {
      const [id] = ids;
      const product = products.find((candidate) => candidate.id === id);
      if (product) return { product, method: "gtin" };
    }
  }

  // Asmodee sometimes appends distributor-only unit metadata to titles.
  // Normalize only evidence-backed distributor suffixes; compareProductIdentity
  // still enforces precise product type, pack count, case/unit and variant safety.
  const sourceTitle = normalizeAsmodeeIdentityTitle(record);
  const source = { title: sourceTitle, tcg: "pokemon" };
  const matches = products.filter((candidate) => compareProductIdentity(source, {
    title: candidate.title,
    productType: candidate.product_type,
    tcg: candidate.tcg || "pokemon",
  }).decision === "match");
  return matches.length === 1 ? { product: matches[0], method: "identity" } : null;
}

export async function syncAsmodeeRrp({ databaseUrl, fetchImpl = fetch, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const collected = await collectAsmodeeRrpRecords({ fetchImpl });
  const pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false } });
  try {
    const [{ rows: products }, { rows: offers }] = await Promise.all([
      pool.query("SELECT id,canonical_key,title,product_type,tcg,official_rrp_pence,rrp_source FROM fatedrop_products"),
      pool.query("SELECT product_id,gtin FROM fatedrop_retail_offers WHERE gtin IS NOT NULL AND gtin <> ''"),
    ]);
    const offersByGtin = new Map();
    for (const offer of offers) {
      const key = normalizeBarcode(offer.gtin);
      if (!key) continue;
      const bucket = offersByGtin.get(key) || [];
      bucket.push(offer);
      offersByGtin.set(key, bucket);
    }

    const updates = [];
    const skipped = [];
    for (const record of collected.records) {
      const match = chooseCanonicalMatch(record, products, offersByGtin);
      if (!match) { skipped.push({ ...record, reason: "no_unique_canonical_match" }); continue; }
      updates.push({ record, product: match.product, method: match.method });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of updates) {
        const { record, product } = item;
        await client.query(
          `UPDATE fatedrop_products SET official_rrp_pence=$1, rrp_source=$2, rrp_observed_at=$3, updated_at=GREATEST(updated_at,$3) WHERE id=$4`,
          [record.officialRrpPence, SOURCE, now, product.id],
        );
        await client.query(
          `INSERT INTO fatedrop_product_identities (id,tcg,canonical_key,title,product_type,official_rrp_pence,rrp_source,rrp_verified_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT (tcg,canonical_key) DO UPDATE SET official_rrp_pence=EXCLUDED.official_rrp_pence, rrp_source=EXCLUDED.rrp_source, rrp_verified_at=EXCLUDED.rrp_verified_at, updated_at=GREATEST(fatedrop_product_identities.updated_at,EXCLUDED.updated_at)`,
          [product.id, product.tcg || "pokemon", product.canonical_key, product.title, product.product_type, record.officialRrpPence, SOURCE, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      source: SOURCE,
      discovered: collected.discovered,
      authoritativeRecords: collected.records.length,
      matched: updates.length,
      matchedByGtin: updates.filter((x) => x.method === "gtin").length,
      matchedByIdentity: updates.filter((x) => x.method === "identity").length,
      skipped: skipped.length,
      fetchErrors: collected.errors.length,
    };
  } finally {
    await pool.end();
  }
}
