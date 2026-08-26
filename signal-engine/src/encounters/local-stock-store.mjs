import crypto from "node:crypto";

const LIFECYCLE = new Set(["whisper", "echo", "manifested", "vanished"]);
const OFFICIAL_EVIDENCE_LEVELS = new Set(["official_branch", "official_collection", "official_retailer_app"]);
const VERIFIED_AVAILABILITY = new Set(["in_stock", "low_stock", "available", "collection_available", "on_shelf"]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function slug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hash(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function epochSeconds(value = Date.now()) {
  const parsed = number(value);
  if (parsed == null) throw new Error("Observation requires a valid occurredAt");
  return Math.floor(parsed > 10_000_000_000 ? parsed / 1000 : parsed);
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeRetailerLocation(record = {}) {
  const retailerId = text(record.retailerId ?? record.retailer_id);
  const provider = text(record.provider)?.toLowerCase();
  const providerId = text(record.providerId ?? record.provider_id);
  const name = text(record.name);
  const latitude = number(record.latitude);
  const longitude = number(record.longitude);
  const postcode = text(record.postcode)?.toUpperCase() || null;
  if (!retailerId) throw new Error("Retailer location requires retailerId");
  if (!provider) throw new Error("Retailer location requires provider");
  if (!name) throw new Error("Retailer location requires name");
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error("Retailer location requires a valid latitude");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("Retailer location requires a valid longitude");
  const identity = providerId
    ? `${retailerId}|${provider}|${providerId}`
    : `${retailerId}|${provider}|${slug(name)}|${postcode || "no-postcode"}`;
  return {
    id: text(record.id) || hash("loc", identity),
    retailerId,
    provider,
    providerId,
    name,
    address: text(record.address),
    postcode,
    latitude,
    longitude,
    website: httpUrl(record.website ?? record.websiteUrl),
    phone: text(record.phone),
    openingDetails: record.openingDetails && typeof record.openingDetails === "object" ? record.openingDetails : {},
    verification: text(record.verification) || "source_verified",
    updatedAt: epochSeconds(record.updatedAt ?? Date.now()),
  };
}

export function normalizeLocalStockObservation(record = {}) {
  const requestedKind = text(record.kind)?.toLowerCase();
  const retailerId = text(record.retailerId ?? record.retailer_id);
  const locationId = text(record.locationId ?? record.location_id);
  const productIdentityId = text(record.productIdentityId ?? record.product_identity_id);
  const occurredAt = epochSeconds(record.occurredAt ?? record.occurred_at ?? Date.now());
  const evidence = record.evidence && typeof record.evidence === "object" ? { ...record.evidence } : {};
  const evidenceLevel = text(evidence.evidenceLevel ?? evidence.level)?.toLowerCase() || "unknown";
  const sourceType = text(evidence.sourceType ?? evidence.source_type)?.toLowerCase();
  const sourceId = text(evidence.sourceId ?? evidence.source_id ?? evidence.sourceUrl ?? evidence.source_url) || "source-unknown";
  const stockStatus = text(evidence.stockStatus ?? evidence.stock_status ?? evidence.availability)?.toLowerCase();
  if (!LIFECYCLE.has(requestedKind)) throw new Error("Local stock observation requires canonical whisper/echo/manifested/vanished kind");
  if (!retailerId) throw new Error("Local stock observation requires retailerId");
  if (!locationId) throw new Error("Local stock observation requires locationId");
  if (!sourceType) throw new Error("Local stock observation requires evidence.sourceType");

  if (requestedKind === "manifested") {
    if (!productIdentityId) throw new Error("Local Manifested requires canonical product identity");
    if (!OFFICIAL_EVIDENCE_LEVELS.has(evidenceLevel)) throw new Error("Local Manifested requires official branch/collection/app evidence");
    if (evidence.availabilityVerified !== true && !VERIFIED_AVAILABILITY.has(stockStatus)) {
      throw new Error("Local Manifested requires verified physical or collection availability evidence");
    }
  }
  if (requestedKind === "vanished") {
    if (!productIdentityId) throw new Error("Local Vanished requires canonical product identity");
    if (!OFFICIAL_EVIDENCE_LEVELS.has(evidenceLevel)) throw new Error("Local Vanished requires official branch/collection/app evidence");
  }

  const bucket = Math.floor(occurredAt / 60);
  const rawTitle = text(evidence.rawProductTitle ?? evidence.raw_product_title ?? evidence.productTitle ?? evidence.title);
  const productKey = productIdentityId || `unresolved:${slug(rawTitle || "unknown-product")}`;
  return {
    id: text(record.id) || hash("lse", `${requestedKind}|${retailerId}|${locationId}|${productKey}|${sourceType}|${sourceId}|${bucket}`),
    kind: requestedKind,
    productIdentityId,
    offerId: text(record.offerId ?? record.offer_id),
    retailerId,
    locationId,
    occurredAt,
    evidence: {
      ...evidence,
      evidenceLevel,
      sourceType,
      ...(stockStatus ? { stockStatus } : {}),
      ...(rawTitle ? { rawProductTitle: rawTitle } : {}),
    },
  };
}

export function normalizeRetailerLocationBatch(records = []) {
  const locations = [];
  const rejected = [];
  const byId = new Map();
  for (let index = 0; index < (Array.isArray(records) ? records : []).length; index += 1) {
    try {
      const location = normalizeRetailerLocation(records[index]);
      byId.set(location.id, location);
    } catch (error) {
      rejected.push({ index, reason: String(error?.message || error) });
    }
  }
  locations.push(...byId.values());
  return { locations, rejected, received: Array.isArray(records) ? records.length : 0, accepted: locations.length };
}

export function normalizeLocalStockObservationBatch(records = []) {
  const observations = [];
  const rejected = [];
  const byId = new Map();
  for (let index = 0; index < (Array.isArray(records) ? records : []).length; index += 1) {
    try {
      const observation = normalizeLocalStockObservation(records[index]);
      byId.set(observation.id, observation);
    } catch (error) {
      rejected.push({ index, reason: String(error?.message || error) });
    }
  }
  observations.push(...byId.values());
  return { observations, rejected, received: Array.isArray(records) ? records.length : 0, accepted: observations.length };
}

export async function upsertRetailerLocationsIntoStore(store, locations = []) {
  if (typeof store?.upsertRetailerLocations === "function") return store.upsertRetailerLocations(locations);
  if (typeof store?.pool !== "function") throw new Error("Retailer location persistence is unavailable");
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const retailerIds = [...new Set(locations.map((location) => location.retailerId))];
    if (retailerIds.length) {
      const { rows } = await client.query("SELECT retailer_id FROM fatedrop_retailer_registry WHERE retailer_id = ANY($1::text[])", [retailerIds]);
      const known = new Set(rows.map((row) => row.retailer_id));
      const missing = retailerIds.filter((id) => !known.has(id));
      if (missing.length) throw new Error(`Unknown canonical retailer IDs: ${missing.join(", ")}`);
    }
    for (const location of locations) {
      await client.query(`
        INSERT INTO fatedrop_retailer_locations (
          id,retailer_id,provider,provider_id,name,address,postcode,latitude,longitude,website,phone,opening_details_json,verification,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          provider=EXCLUDED.provider,
          provider_id=COALESCE(EXCLUDED.provider_id,fatedrop_retailer_locations.provider_id),
          name=EXCLUDED.name,
          address=COALESCE(EXCLUDED.address,fatedrop_retailer_locations.address),
          postcode=COALESCE(EXCLUDED.postcode,fatedrop_retailer_locations.postcode),
          latitude=EXCLUDED.latitude,
          longitude=EXCLUDED.longitude,
          website=COALESCE(EXCLUDED.website,fatedrop_retailer_locations.website),
          phone=COALESCE(EXCLUDED.phone,fatedrop_retailer_locations.phone),
          opening_details_json=COALESCE(EXCLUDED.opening_details_json,fatedrop_retailer_locations.opening_details_json),
          verification=EXCLUDED.verification,
          updated_at=GREATEST(EXCLUDED.updated_at,fatedrop_retailer_locations.updated_at)
      `, [
        location.id,location.retailerId,location.provider,location.providerId,location.name,location.address,location.postcode,
        location.latitude,location.longitude,location.website,location.phone,JSON.stringify(location.openingDetails),location.verification,location.updatedAt,
      ]);
    }
    await client.query("COMMIT");
    return { saved: locations.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hasPriorManifested(store, observation, client = null) {
  if (typeof store?.hasPriorLocalManifested === "function") {
    return store.hasPriorLocalManifested({
      locationId: observation.locationId,
      productIdentityId: observation.productIdentityId,
      before: observation.occurredAt,
    });
  }
  const queryable = client || (typeof store?.pool === "function" ? await store.pool() : null);
  if (!queryable) return false;
  const { rows } = await queryable.query(`
    SELECT 1 FROM fatedrop_signal_events
    WHERE location_id=$1 AND product_identity_id=$2 AND kind='manifested' AND occurred_at < $3
    ORDER BY occurred_at DESC LIMIT 1
  `, [observation.locationId, observation.productIdentityId, observation.occurredAt]);
  return rows.length > 0;
}

export async function upsertLocalStockObservationsIntoStore(store, observations = []) {
  if (typeof store?.upsertLocalStockObservations === "function") {
    const accepted = [];
    const rejected = [];
    for (const observation of observations) {
      if (observation.kind === "vanished" && !(await hasPriorManifested(store, observation))) {
        rejected.push({ id: observation.id, reason: "Local Vanished requires prior Manifested history for the same branch and product" });
      } else {
        accepted.push(observation);
      }
    }
    const result = accepted.length ? await store.upsertLocalStockObservations(accepted) : { saved: 0 };
    return { ...result, rejected };
  }
  if (typeof store?.pool !== "function") throw new Error("Local stock observation persistence is unavailable");
  const pool = await store.pool();
  const client = await pool.connect();
  const rejected = [];
  let saved = 0;
  let duplicates = 0;
  try {
    await client.query("BEGIN");
    for (const observation of observations) {
      const { rows: locationRows } = await client.query("SELECT retailer_id FROM fatedrop_retailer_locations WHERE id=$1", [observation.locationId]);
      if (!locationRows[0]) { rejected.push({ id: observation.id, reason: "Unknown retailer location" }); continue; }
      if (locationRows[0].retailer_id !== observation.retailerId) { rejected.push({ id: observation.id, reason: "Retailer/location identity mismatch" }); continue; }
      if (observation.productIdentityId) {
        const { rows: productRows } = await client.query("SELECT 1 FROM fatedrop_product_identities WHERE id=$1", [observation.productIdentityId]);
        if (!productRows.length) { rejected.push({ id: observation.id, reason: "Unknown canonical product identity" }); continue; }
      }
      if (observation.kind === "vanished" && !(await hasPriorManifested(store, observation, client))) {
        rejected.push({ id: observation.id, reason: "Local Vanished requires prior Manifested history for the same branch and product" });
        continue;
      }
      const result = await client.query(`
        INSERT INTO fatedrop_signal_events (id,kind,product_identity_id,offer_id,retailer_id,location_id,occurred_at,evidence_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT (id) DO NOTHING
      `, [
        observation.id,observation.kind,observation.productIdentityId,observation.offerId,observation.retailerId,
        observation.locationId,observation.occurredAt,JSON.stringify(observation.evidence),
      ]);
      if (result.rowCount === 1) saved += 1;
      else duplicates += 1;
    }
    await client.query("COMMIT");
    return { saved, duplicates, rejected };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
