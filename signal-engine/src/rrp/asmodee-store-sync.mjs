import {
  chooseCanonicalMatch,
  collectAsmodeeRrpRecords,
  writeAsmodeeRrpUpdates,
} from "./asmodee-authority.mjs";

const SOURCE = "asmodee-uk";

function normalizeBarcode(value = "") {
  return String(value).replace(/\D+/g, "");
}

export async function syncAsmodeeRrpWithPool({
  pool,
  fetchImpl = fetch,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("Asmodee RRP sync requires the canonical PostgreSQL pool");
  }

  const collected = await collectAsmodeeRrpRecords({ fetchImpl });
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
    if (!match) {
      skipped.push({ ...record, reason: "no_unique_canonical_match" });
      continue;
    }
    updates.push({ record, product: match.product, method: match.method });
  }

  const client = await pool.connect();
  try {
    await writeAsmodeeRrpUpdates(client, updates, now);
  } finally {
    client.release();
  }

  return {
    source: SOURCE,
    discovered: collected.discovered,
    authoritativeRecords: collected.records.length,
    matched: updates.length,
    matchedByGtin: updates.filter((item) => item.method === "gtin").length,
    matchedByIdentity: updates.filter((item) => item.method === "identity").length,
    skipped: skipped.length,
    fetchErrors: collected.errors.length,
    fetchErrorCounts: collected.errorCounts,
  };
}
