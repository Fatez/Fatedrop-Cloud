const LOCAL_SIGNAL_KINDS = new Set([
  "local_incoming",
  "local_in_stock",
  "local_low_stock",
  "local_out_of_stock",
]);

const OFFICIAL_EVIDENCE_LEVELS = new Set([
  "official_branch",
  "official_collection",
  "official_retailer_app",
]);

const DEFAULT_TTL_MS = Object.freeze({
  local_incoming: 24 * 60 * 60 * 1000,
  local_in_stock: 2 * 60 * 60 * 1000,
  local_low_stock: 90 * 60 * 1000,
  local_out_of_stock: 2 * 60 * 60 * 1000,
});

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
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function asEpochMs(value) {
  const parsed = number(value);
  if (parsed == null) return null;
  return parsed > 10_000_000_000 ? parsed : parsed * 1000;
}

function ttlFor(observation) {
  const explicit = asEpochMs(observation?.expiresAt);
  if (explicit != null) return Math.max(0, explicit - observation.occurredAt);
  return DEFAULT_TTL_MS[observation?.kind] || 2 * 60 * 60 * 1000;
}

function evidenceLevel(evidence = {}) {
  return text(evidence.evidenceLevel || evidence.level || evidence.scope)?.toLowerCase() || "unknown";
}

function confidence(evidence = {}) {
  const value = number(evidence.confidence);
  return value == null ? null : Math.max(0, Math.min(1, value));
}

function statusFromObservation(observation) {
  const level = evidenceLevel(observation.evidence);
  const official = OFFICIAL_EVIDENCE_LEVELS.has(level);
  if (observation.kind === "local_in_stock") return official ? "in_stock" : "incoming_watch";
  if (observation.kind === "local_low_stock") return official ? "low_stock" : "incoming_watch";
  if (observation.kind === "local_out_of_stock") return official ? "out_of_stock" : "unknown";
  if (observation.kind === "local_incoming") return "incoming_watch";
  return "unknown";
}

function statusRank(status) {
  return ({ in_stock: 5, low_stock: 4, incoming_watch: 3, out_of_stock: 2, unknown: 1 })[status] || 0;
}

function normalizeObservation(row = {}) {
  const occurredAt = asEpochMs(row.occurredAt ?? row.occurred_at) || Date.now();
  const evidence = row.evidence && typeof row.evidence === "object"
    ? row.evidence
    : row.evidence_json && typeof row.evidence_json === "object"
      ? row.evidence_json
      : {};
  const observation = {
    id: text(row.id),
    kind: text(row.kind)?.toLowerCase() || "unknown",
    productIdentityId: text(row.productIdentityId ?? row.product_identity_id),
    productTitle: text(row.productTitle ?? row.product_title ?? evidence.productTitle ?? evidence.title),
    retailerId: text(row.retailerId ?? row.retailer_id),
    locationId: text(row.locationId ?? row.location_id),
    locationProvider: text(row.locationProvider ?? row.location_provider),
    locationProviderId: text(row.locationProviderId ?? row.location_provider_id),
    locationName: text(row.locationName ?? row.location_name),
    latitude: number(row.latitude),
    longitude: number(row.longitude),
    occurredAt,
    evidence,
  };
  const expiresAt = asEpochMs(evidence.expiresAt ?? evidence.expires_at);
  return {
    ...observation,
    expiresAt: expiresAt || occurredAt + (DEFAULT_TTL_MS[observation.kind] || 2 * 60 * 60 * 1000),
    evidenceLevel: evidenceLevel(evidence),
    confidence: confidence(evidence),
    sourceType: text(evidence.sourceType || evidence.source_type),
    sourceUrl: text(evidence.sourceUrl || evidence.source_url),
    localStockStatus: statusFromObservation(observation),
  };
}

export async function listLocalStockObservationsFromStore(store, { sinceMs = Date.now() - 24 * 60 * 60 * 1000, limit = 2000 } = {}) {
  if (typeof store?.listLocalStockObservations === "function") {
    const rows = await store.listLocalStockObservations({ sinceMs, limit });
    return (rows || []).map(normalizeObservation).filter((item) => LOCAL_SIGNAL_KINDS.has(item.kind));
  }
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 2000));
  const sinceSeconds = Math.floor(Math.max(0, sinceMs) / 1000);
  const { rows } = await pool.query(`
    SELECT
      se.id,
      se.kind,
      se.product_identity_id,
      pi.title AS product_title,
      se.retailer_id,
      se.location_id,
      se.occurred_at,
      se.evidence_json,
      rl.provider AS location_provider,
      rl.provider_id AS location_provider_id,
      rl.name AS location_name,
      rl.latitude,
      rl.longitude
    FROM fatedrop_signal_events se
    LEFT JOIN fatedrop_retailer_locations rl ON rl.id = se.location_id
    LEFT JOIN fatedrop_product_identities pi ON pi.id = se.product_identity_id
    WHERE se.location_id IS NOT NULL
      AND se.kind = ANY($1::text[])
      AND se.occurred_at >= $2
    ORDER BY se.occurred_at DESC
    LIMIT $3
  `, [[...LOCAL_SIGNAL_KINDS], sinceSeconds, safeLimit]);
  return rows.map(normalizeObservation);
}

function sameBranch(shop, observation) {
  if (shop.provider === observation.locationProvider && shop.providerPlaceId && observation.locationProviderId) {
    return String(shop.providerPlaceId) === String(observation.locationProviderId);
  }
  if (shop.retailerId && observation.retailerId && shop.retailerId !== observation.retailerId) return false;
  if (shop.retailerId && observation.retailerId && shop.retailerId === observation.retailerId) {
    if (shop.name && observation.locationName && slug(shop.name) === slug(observation.locationName)) return true;
    if ([shop.latitude, shop.longitude, observation.latitude, observation.longitude].every(Number.isFinite)) {
      const dLat = Math.abs(shop.latitude - observation.latitude);
      const dLng = Math.abs(shop.longitude - observation.longitude);
      return dLat <= 0.004 && dLng <= 0.007;
    }
  }
  return false;
}

export function enrichShopsWithLocalStock(shops = [], observations = [], now = Date.now()) {
  const active = (observations || [])
    .map((item) => item.localStockStatus ? item : normalizeObservation(item))
    .filter((item) => LOCAL_SIGNAL_KINDS.has(item.kind))
    .filter((item) => item.occurredAt + ttlFor(item) > now && item.expiresAt > now);

  return (shops || []).map((shop) => {
    const branchObservations = active.filter((item) => sameBranch(shop, item));
    if (!branchObservations.length) {
      return {
        ...shop,
        localStockStatus: shop.localStockStatus || "unknown",
        localStockEvidence: null,
        localStockProducts: [],
      };
    }

    branchObservations.sort((a, b) => {
      const rank = statusRank(b.localStockStatus) - statusRank(a.localStockStatus);
      return rank || b.occurredAt - a.occurredAt;
    });
    const strongest = branchObservations[0];
    const products = [];
    const seen = new Set();
    for (const item of branchObservations) {
      const key = item.productIdentityId || item.productTitle || item.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      products.push({
        productIdentityId: item.productIdentityId,
        title: item.productTitle || "Trading card product",
        status: item.localStockStatus,
        observedAt: new Date(item.occurredAt).toISOString(),
        evidenceLevel: item.evidenceLevel,
        confidence: item.confidence,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
      });
      if (products.length >= 8) break;
    }

    return {
      ...shop,
      localStockStatus: strongest.localStockStatus,
      localStockEvidence: {
        evidenceLevel: strongest.evidenceLevel,
        confidence: strongest.confidence,
        sourceType: strongest.sourceType,
        sourceUrl: strongest.sourceUrl,
        observedAt: new Date(strongest.occurredAt).toISOString(),
        verifiedBranchStock: OFFICIAL_EVIDENCE_LEVELS.has(strongest.evidenceLevel)
          && ["in_stock", "low_stock", "out_of_stock"].includes(strongest.localStockStatus),
      },
      localStockProducts: products,
    };
  });
}

export function localStockCounts(shops = []) {
  return (shops || []).reduce((counts, shop) => {
    if (shop.localStockStatus === "in_stock") counts.inStock += 1;
    else if (shop.localStockStatus === "low_stock") counts.lowStock += 1;
    else if (shop.localStockStatus === "incoming_watch") counts.incomingWatch += 1;
    return counts;
  }, { inStock: 0, lowStock: 0, incomingWatch: 0 });
}

export const LOCAL_STOCK_POLICY = Object.freeze({
  officialEvidenceLevels: [...OFFICIAL_EVIDENCE_LEVELS],
  communityRule: "Community or social evidence may create an incoming watch but never a verified in-stock claim.",
  liveStockTtlMinutes: DEFAULT_TTL_MS.local_in_stock / 60_000,
  lowStockTtlMinutes: DEFAULT_TTL_MS.local_low_stock / 60_000,
  incomingWatchTtlHours: DEFAULT_TTL_MS.local_incoming / 3_600_000,
});
