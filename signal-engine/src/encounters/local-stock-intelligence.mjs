import { calculateOfferIntelligence } from "../core/price-intelligence.mjs";

const LOCAL_SIGNAL_KINDS = new Set([
  "whisper",
  "echo",
  "manifested",
  "vanished",
]);

const OFFICIAL_EVIDENCE_LEVELS = new Set([
  "official_branch",
  "official_collection",
  "official_retailer_app",
]);

const DEFAULT_TTL_MS = Object.freeze({
  whisper: 12 * 60 * 60 * 1000,
  echo: 24 * 60 * 60 * 1000,
  manifested: 2 * 60 * 60 * 1000,
  vanished: 2 * 60 * 60 * 1000,
});

const EVIDENCE_TTL_MS = Object.freeze({
  official_branch: 2 * 60 * 60 * 1000,
  official_collection: 90 * 60 * 1000,
  official_retailer_app: 90 * 60 * 1000,
  verified_shelf_sighting: 45 * 60 * 1000,
  community_report: 30 * 60 * 1000,
  curated_manual: 72 * 60 * 60 * 1000,
  retailer_staff_report: 48 * 60 * 60 * 1000,
  official_store_social: 12 * 60 * 60 * 1000,
  inventory_preparation: 24 * 60 * 60 * 1000,
});

const VERIFIED_AVAILABILITY_STATES = new Set([
  "in_stock",
  "low_stock",
  "available",
  "collection_available",
  "on_shelf",
]);

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
  if (parsed != null) return parsed > 10_000_000_000 ? parsed : parsed * 1000;
  if (typeof value === "string") {
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return null;
}

function evidenceLevel(evidence = {}) {
  return text(evidence.evidenceLevel || evidence.level || evidence.scope)?.toLowerCase() || "unknown";
}

function confidence(evidence = {}) {
  const value = number(evidence.confidence);
  return value == null ? null : Math.max(0, Math.min(1, value));
}

function sourceType(evidence = {}) {
  return text(evidence.sourceType || evidence.source_type)?.toLowerCase() || null;
}

function evidenceStockStatus(evidence = {}) {
  return text(evidence.stockStatus || evidence.stock_status || evidence.availability)?.toLowerCase() || null;
}

function evidencePricePence(evidence = {}) {
  return number(evidence.itemPricePence ?? evidence.item_price_pence ?? evidence.pricePence ?? evidence.price_pence);
}

function ttlForEvidence({ kind, level, source }) {
  return EVIDENCE_TTL_MS[source]
    || EVIDENCE_TTL_MS[level]
    || DEFAULT_TTL_MS[kind]
    || 2 * 60 * 60 * 1000;
}

function hasVerifiedAvailabilityEvidence(observation) {
  return observation.evidence?.availabilityVerified === true
    || VERIFIED_AVAILABILITY_STATES.has(observation.stockStatus);
}

function statusFromObservation(observation) {
  if (["whisper", "echo"].includes(observation.kind)) return "incoming_watch";
  const official = OFFICIAL_EVIDENCE_LEVELS.has(observation.evidenceLevel);
  const canonicalIdentityKnown = Boolean(observation.productIdentityId);
  if (observation.kind === "manifested") {
    if (!official || !canonicalIdentityKnown || !hasVerifiedAvailabilityEvidence(observation)) return "incoming_watch";
    return observation.stockStatus === "low_stock" ? "low_stock" : "in_stock";
  }
  if (observation.kind === "vanished") {
    return official && canonicalIdentityKnown ? "out_of_stock" : "unknown";
  }
  return "unknown";
}

function statusRank(status) {
  return ({ in_stock: 5, low_stock: 4, incoming_watch: 3, out_of_stock: 2, unknown: 1 })[status] || 0;
}

function availabilityClass(status) {
  if (["in_stock", "low_stock"].includes(status)) return "available";
  if (status === "out_of_stock") return "unavailable";
  if (status === "incoming_watch") return "preparation";
  return "unknown";
}

function defaultConfidence(item) {
  if (item.evidenceLevel === "official_branch") return 0.92;
  if (["official_collection", "official_retailer_app"].includes(item.evidenceLevel)) return 0.88;
  if (item.evidenceLevel === "verified_shelf_sighting") return 0.82;
  if (item.sourceType === "official_store_social") return 0.68;
  if (item.sourceType === "retailer_staff_report") return 0.58;
  if (item.sourceType === "curated_manual") return 0.48;
  if (item.evidenceLevel === "community_report") return 0.5;
  if (item.kind === "echo") return 0.62;
  if (item.kind === "whisper") return 0.48;
  return 0.45;
}

function effectiveConfidence(item, now) {
  const base = item.confidence ?? defaultConfidence(item);
  const ttl = Math.max(1, item.expiresAt - item.occurredAt);
  const age = Math.max(0, now - item.occurredAt);
  const ageRatio = Math.min(1, age / ttl);
  const decayFactor = Math.max(0.25, 1 - (ageRatio * 0.75));
  return Math.max(0, Math.min(1, base * decayFactor));
}

function valueIntelligence(item) {
  const intelligence = calculateOfferIntelligence({
    pricePence: item.pricePence,
    postagePence: null,
    officialRrpPence: item.officialRrpPence,
    rrpSource: item.rrpSource,
    rrpObservedAt: item.rrpObservedAt,
    retailerId: item.retailerId,
    evidence: [{ kind: item.sourceType || item.evidenceLevel || "local_stock_observation" }],
  });
  return {
    priceKnown: intelligence.priceKnown,
    rawObservedPricePence: intelligence.rawObservedPricePence,
    itemPricePence: intelligence.canonicalPricePence,
    priceQuality: intelligence.priceQuality,
    priceConfidence: intelligence.priceConfidence,
    rrp: intelligence.rrp,
    itemVsRrp: intelligence.itemVsRrp,
  };
}

function normalizeObservation(row = {}) {
  const occurredAt = asEpochMs(row.occurredAt ?? row.occurred_at) || Date.now();
  const evidence = row.evidence && typeof row.evidence === "object"
    ? row.evidence
    : row.evidence_json && typeof row.evidence_json === "object"
      ? row.evidence_json
      : {};
  const level = evidenceLevel(evidence);
  const source = sourceType(evidence);
  const observation = {
    id: text(row.id),
    kind: text(row.kind)?.toLowerCase() || "unknown",
    productIdentityId: text(row.productIdentityId ?? row.product_identity_id),
    productTitle: text(row.productTitle ?? row.product_title ?? evidence.productTitle ?? evidence.rawProductTitle ?? evidence.raw_product_title ?? evidence.title),
    retailerId: text(row.retailerId ?? row.retailer_id),
    locationId: text(row.locationId ?? row.location_id),
    locationProvider: text(row.locationProvider ?? row.location_provider),
    locationProviderId: text(row.locationProviderId ?? row.location_provider_id),
    locationName: text(row.locationName ?? row.location_name),
    occurredAt,
    evidence,
    evidenceLevel: level,
    confidence: confidence(evidence),
    sourceType: source,
    sourceUrl: text(evidence.sourceUrl || evidence.source_url),
    stockStatus: evidenceStockStatus(evidence),
    pricePence: evidencePricePence(evidence),
    officialRrpPence: number(row.officialRrpPence ?? row.product_official_rrp_pence),
    rrpSource: text(row.rrpSource ?? row.rrp_source),
    rrpObservedAt: asEpochMs(row.rrpObservedAt ?? row.rrp_verified_at),
  };
  const expiresAt = asEpochMs(evidence.expiresAt ?? evidence.expires_at)
    || asEpochMs(row.expiresAt ?? row.expires_at)
    || occurredAt + ttlForEvidence({ kind: observation.kind, level, source });
  return {
    ...observation,
    expiresAt,
    localStockStatus: statusFromObservation(observation),
  };
}

export async function listLocalStockObservationsFromStore(store, { sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000, limit = 2000 } = {}) {
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
      pi.official_rrp_pence AS product_official_rrp_pence,
      pi.rrp_source,
      pi.rrp_verified_at,
      se.retailer_id,
      se.location_id,
      se.occurred_at,
      se.evidence_json,
      rl.provider AS location_provider,
      rl.provider_id AS location_provider_id,
      rl.name AS location_name
    FROM fatedrop_signal_events se
    LEFT JOIN fatedrop_retailer_locations rl ON rl.id = se.location_id
    LEFT JOIN fatedrop_product_identities pi ON pi.id = se.product_identity_id
    WHERE (
        se.location_id IS NOT NULL
        OR (se.location_id IS NULL AND COALESCE(se.evidence_json->>'localIntel','false')='true' AND se.evidence_json->>'scope'='retailer_chain')
      )
      AND se.kind = ANY($1::text[])
      AND se.occurred_at >= $2
    ORDER BY se.occurred_at DESC
    LIMIT $3
  `, [[...LOCAL_SIGNAL_KINDS], sinceSeconds, safeLimit]);
  return rows.map(normalizeObservation);
}

function sameBranch(shop, observation) {
  if (!observation.locationId && observation.evidence?.localIntel === true && observation.evidence?.scope === "retailer_chain") {
    return Boolean(shop.retailerId && observation.retailerId && shop.retailerId === observation.retailerId);
  }
  if (shop.provider === observation.locationProvider && shop.providerPlaceId && observation.locationProviderId) {
    return String(shop.providerPlaceId) === String(observation.locationProviderId);
  }
  if (!shop.retailerId || !observation.retailerId || shop.retailerId !== observation.retailerId) return false;
  return Boolean(shop.name && observation.locationName && slug(shop.name) === slug(observation.locationName));
}

function productKey(item) {
  if (item.productIdentityId) return `id:${item.productIdentityId}`;
  if (item.productTitle) return `title:${slug(item.productTitle)}`;
  return item.id ? `event:${item.id}` : null;
}

function sourceKey(item) {
  return item.sourceUrl || `${item.evidenceLevel}:${item.sourceType || "unknown"}`;
}

function resolveCurrentProductObservations(branchObservations, now) {
  const groups = new Map();
  for (const item of branchObservations) {
    const key = productKey(item);
    if (!key) continue;
    const rows = groups.get(key) || [];
    rows.push(item);
    groups.set(key, rows);
  }

  const resolved = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => b.occurredAt - a.occurredAt);
    const latest = rows[0];
    const hadEarlierManifested = rows.some((item) => item.kind === "manifested" && item.occurredAt < latest.occurredAt && ["in_stock", "low_stock"].includes(item.localStockStatus));
    const orphanVanished = latest.kind === "vanished" && !hadEarlierManifested;
    const latestClass = availabilityClass(orphanVanished ? "unknown" : latest.localStockStatus);
    const contradictionWindowMs = Math.min(30 * 60 * 1000, Math.max(1, latest.expiresAt - latest.occurredAt));
    const relevant = rows.filter((item) => latest.occurredAt - item.occurredAt <= contradictionWindowMs);
    const contradictions = relevant.filter((item) => {
      const currentClass = availabilityClass(item.localStockStatus);
      return ["available", "unavailable"].includes(latestClass)
        && ["available", "unavailable"].includes(currentClass)
        && currentClass !== latestClass;
    });
    const corroborating = relevant.filter((item) => availabilityClass(item.localStockStatus) === latestClass);
    const sourceDiversity = new Set(corroborating.map(sourceKey).filter(Boolean));
    const contradictionPenalty = Math.min(0.4, contradictions.length * 0.15);
    const corroborationBoost = Math.min(0.12, Math.max(0, sourceDiversity.size - 1) * 0.04);
    const rawEffective = effectiveConfidence(latest, now);
    const adjustedConfidence = Math.max(0, Math.min(1, rawEffective - contradictionPenalty + corroborationBoost));
    const conflictForcesUnknown = ["available", "unavailable"].includes(latestClass)
      && contradictions.length > 0
      && adjustedConfidence < 0.55;
    resolved.push({
      ...latest,
      localStockStatus: orphanVanished || conflictForcesUnknown ? "unknown" : latest.localStockStatus,
      effectiveConfidence: adjustedConfidence,
      corroborationCount: corroborating.length,
      sourceDiversityCount: sourceDiversity.size,
      contradictionCount: contradictions.length,
      orphanVanished,
      freshnessAgeMinutes: Math.max(0, Math.round((now - latest.occurredAt) / 60_000)),
      value: valueIntelligence(latest),
    });
  }
  return resolved;
}

export function enrichShopsWithLocalStock(shops = [], observations = [], now = Date.now()) {
  const active = (observations || [])
    .map(normalizeObservation)
    .filter((item) => LOCAL_SIGNAL_KINDS.has(item.kind))
    .filter((item) => item.expiresAt > now);

  return (shops || []).map((shop) => {
    const branchObservations = active.filter((item) => sameBranch(shop, item));
    const currentProducts = resolveCurrentProductObservations(branchObservations, now);
    if (!currentProducts.length) {
      return {
        ...shop,
        localStockStatus: shop.localStockStatus || "unknown",
        localStockEvidence: null,
        localStockProducts: [],
      };
    }

    currentProducts.sort((a, b) => {
      const rank = statusRank(b.localStockStatus) - statusRank(a.localStockStatus);
      return rank || b.effectiveConfidence - a.effectiveConfidence || b.occurredAt - a.occurredAt;
    });
    const strongest = currentProducts[0];
    const products = currentProducts.slice(0, 8).map((item) => ({
      productIdentityId: item.productIdentityId,
      title: item.productTitle || "Trading card product",
      lifecycleState: item.kind,
      status: item.localStockStatus,
      observedAt: new Date(item.occurredAt).toISOString(),
      expiresAt: new Date(item.expiresAt).toISOString(),
      evidenceLevel: item.evidenceLevel,
      confidence: item.effectiveConfidence,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      freshnessAgeMinutes: item.freshnessAgeMinutes,
      corroborationCount: item.corroborationCount,
      sourceDiversityCount: item.sourceDiversityCount,
      contradictionCount: item.contradictionCount,
      orphanVanished: item.orphanVanished,
      advisory: item.evidence?.advisory === true || item.evidence?.localIntel === true,
      scope: text(item.evidence?.scope),
      expectedFrom: text(item.evidence?.expectedFrom || item.evidence?.expected_from),
      expectedTo: text(item.evidence?.expectedTo || item.evidence?.expected_to),
      note: text(item.evidence?.note),
      sourceLabel: text(item.evidence?.sourceLabel || item.evidence?.source_label),
      value: item.value,
    }));

    return {
      ...shop,
      localStockStatus: strongest.localStockStatus,
      localStockEvidence: {
        lifecycleState: strongest.kind,
        evidenceLevel: strongest.evidenceLevel,
        confidence: strongest.effectiveConfidence,
        sourceType: strongest.sourceType,
        sourceUrl: strongest.sourceUrl,
        observedAt: new Date(strongest.occurredAt).toISOString(),
        expiresAt: new Date(strongest.expiresAt).toISOString(),
        freshnessAgeMinutes: strongest.freshnessAgeMinutes,
        corroborationCount: strongest.corroborationCount,
        sourceDiversityCount: strongest.sourceDiversityCount,
        contradictionCount: strongest.contradictionCount,
        orphanVanished: strongest.orphanVanished,
        advisory: strongest.evidence?.advisory === true || strongest.evidence?.localIntel === true,
        scope: text(strongest.evidence?.scope),
        expectedFrom: text(strongest.evidence?.expectedFrom || strongest.evidence?.expected_from),
        expectedTo: text(strongest.evidence?.expectedTo || strongest.evidence?.expected_to),
        note: text(strongest.evidence?.note),
        sourceLabel: text(strongest.evidence?.sourceLabel || strongest.evidence?.source_label),
        verifiedBranchStock: strongest.kind === "manifested"
          && OFFICIAL_EVIDENCE_LEVELS.has(strongest.evidenceLevel)
          && Boolean(strongest.productIdentityId)
          && ["in_stock", "low_stock"].includes(strongest.localStockStatus),
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
  lifecycleStates: [...LOCAL_SIGNAL_KINDS],
  officialEvidenceLevels: [...OFFICIAL_EVIDENCE_LEVELS],
  communityRule: "Community, manual or social evidence may strengthen preparation intelligence but cannot create verified Manifested branch stock.",
  chainIntelRule: "Retailer-chain intel is advisory and may be overlaid onto nearby branches of that retailer only as an Incoming Watch until exact branch evidence exists.",
  identityRule: "Verified physical Manifested stock requires a canonical product identity and an exact branch match.",
  rrpRule: "Local Radar uses the shared canonical RRP and price-intelligence engine; retailer selling price is never learned as RRP.",
  vanishedRule: "A branch Vanished state is only accepted when a previously verified Manifested observation exists for that branch and product.",
  contradictionRule: "Recent contradictory availability evidence reduces confidence and can force the current state to unknown.",
  manifestedTtlMinutes: DEFAULT_TTL_MS.manifested / 60_000,
  shelfSightingTtlMinutes: EVIDENCE_TTL_MS.verified_shelf_sighting / 60_000,
  echoTtlHours: DEFAULT_TTL_MS.echo / 3_600_000,
});
