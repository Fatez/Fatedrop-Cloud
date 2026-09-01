import { calculateOfferIntelligence } from "../core/price-intelligence.mjs";

const STORED_LOCAL_SIGNAL_KINDS = new Set(["whisper", "echo", "manifested", "vanished"]);
const PHYSICAL_EVIDENCE_STATES = new Set(["expected", "reported", "verified", "expired"]);

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

export const EXPECTED_STOCK_DISCLAIMER = "Expected stock information is indicative only and is not guaranteed. Availability, delivery timing and quantities may vary by store. We recommend checking with the retailer before travelling.";

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

function physicalEvidenceState(observation) {
  const explicit = text(
    observation.physicalEvidenceState
    ?? observation.physical_evidence_state
    ?? observation.evidence?.physicalEvidenceState
    ?? observation.evidence?.physical_evidence_state,
  )?.toLowerCase();
  if (explicit && PHYSICAL_EVIDENCE_STATES.has(explicit)) return explicit;
  if (observation.evidenceLevel === "community_report"
    || ["retailer_staff_report", "official_store_social", "retailer_submission", "community_report", "community_sighting", "verified_shelf_sighting"].includes(observation.sourceType)) return "reported";
  if (observation.sourceLifecycleState === "manifested") return "verified";
  if (observation.sourceLifecycleState === "vanished") return "expired";
  return "expected";
}

function statusFromObservation(observation) {
  if (observation.physicalEvidenceState === "verified") {
    const official = OFFICIAL_EVIDENCE_LEVELS.has(observation.evidenceLevel);
    const canonicalIdentityKnown = Boolean(observation.productIdentityId);
    if (!official || !canonicalIdentityKnown || !hasVerifiedAvailabilityEvidence(observation)) return "unknown";
    return observation.stockStatus === "low_stock" ? "low_stock" : "in_stock";
  }
  if (observation.physicalEvidenceState === "reported") return "reported_watch";
  if (observation.physicalEvidenceState === "expected") return "incoming_watch";
  if (observation.physicalEvidenceState === "expired") return "no_longer_confirmed";
  return "unknown";
}

function statusRank(status) {
  return ({ in_stock: 6, low_stock: 5, reported_watch: 4, incoming_watch: 3, no_longer_confirmed: 2, unknown: 1 })[status] || 0;
}

function availabilityClass(status) {
  if (["in_stock", "low_stock"].includes(status)) return "available";
  if (status === "reported_watch") return "reported";
  if (status === "incoming_watch") return "preparation";
  if (status === "no_longer_confirmed") return "expired";
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
    sourceLifecycleState: text(row.sourceLifecycleState ?? row.source_lifecycle_state ?? row.kind)?.toLowerCase() || "unknown",
kind: "echo",
    productIdentityId: text(row.productIdentityId ?? row.product_identity_id),
    productTitle: text(row.productTitle ?? row.product_title ?? evidence.productTitle ?? evidence.rawProductTitle ?? evidence.raw_product_title ?? evidence.title),
    retailerId: text(row.retailerId ?? row.retailer_id),
    locationId: text(row.locationId ?? row.location_id),
    locationProvider: text(row.locationProvider ?? row.location_provider),
    locationProviderId: text(row.locationProviderId ?? row.location_provider_id),
    locationName: text(row.locationName ?? row.location_name),
    occurredAt,
    evidence,
    physicalEvidenceState: text(row.physicalEvidenceState ?? row.physical_evidence_state)?.toLowerCase(),
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
  || occurredAt + ttlForEvidence({ kind: observation.sourceLifecycleState, level, source });
const normalized = { ...observation, physicalEvidenceState: physicalEvidenceState(observation), expiresAt };
return { ...normalized, localStockStatus: statusFromObservation(normalized) };
}

export async function listLocalStockObservationsFromStore(store, { sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000, limit = 2000 } = {}) {
  if (typeof store?.listLocalStockObservations === "function") {
    const rows = await store.listLocalStockObservations({ sinceMs, limit });
return (rows || []).map(normalizeObservation).filter((item) => STORED_LOCAL_SIGNAL_KINDS.has(item.sourceLifecycleState));
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
`, [[...STORED_LOCAL_SIGNAL_KINDS], sinceSeconds, safeLimit]);
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
const orphanVanished = false;
const latestClass = availabilityClass(latest.localStockStatus);
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
localStockStatus: conflictForcesUnknown ? "unknown" : latest.localStockStatus,
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

function expectedFields(item) {
  return {
    expectedFrom: text(item.evidence?.expectedFrom || item.evidence?.expected_from),
    expectedTo: text(item.evidence?.expectedTo || item.evidence?.expected_to),
    expectedLabel: text(item.evidence?.expectedLabel || item.evidence?.expected_label),
  };
}

function isVerifiedBranchStock(item) {
  return item.physicalEvidenceState === "verified"
    && OFFICIAL_EVIDENCE_LEVELS.has(item.evidenceLevel)
    && Boolean(item.productIdentityId)
    && ["in_stock", "low_stock"].includes(item.localStockStatus);
}

function consumerLocalState(item) {
  if (isVerifiedBranchStock(item)) return "confirmed";
  const expected = expectedFields(item);
if (["expected", "reported"].includes(item.physicalEvidenceState)) return "expected";
  return "unknown";
}

function localAvailabilityProjection(products) {
  const confirmed = products.find((item) => item.localState === "confirmed") || null;
  const expected = products.find((item) => item.localState === "expected") || null;
  return {
    status: confirmed ? "confirmed" : expected ? "expected" : "unknown",
    expected: expected ? {
      title: expected.title,
      productIdentityId: expected.productIdentityId,
      expectedFrom: expected.expectedFrom,
      expectedTo: expected.expectedTo,
      expectedLabel: expected.expectedLabel,
      advisory: true,
      sourceLabel: expected.sourceLabel,
      sourceUrl: expected.sourceUrl,
    } : null,
    confirmed: confirmed ? {
      title: confirmed.title,
      productIdentityId: confirmed.productIdentityId,
      observedAt: confirmed.observedAt,
      sourceLabel: confirmed.sourceLabel,
      sourceUrl: confirmed.sourceUrl,
    } : null,
    disclaimer: expected ? EXPECTED_STOCK_DISCLAIMER : null,
  };
}

export function enrichShopsWithLocalStock(shops = [], observations = [], now = Date.now()) {
  const active = (observations || [])
    .map(normalizeObservation)
.filter((item) => STORED_LOCAL_SIGNAL_KINDS.has(item.sourceLifecycleState))
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
        localAvailability: {
          status: "unknown",
          expected: null,
          confirmed: null,
          disclaimer: null,
        },
      };
    }

    currentProducts.sort((a, b) => {
      const rank = statusRank(b.localStockStatus) - statusRank(a.localStockStatus);
      return rank || b.effectiveConfidence - a.effectiveConfidence || b.occurredAt - a.occurredAt;
    });
    const strongest = currentProducts[0];
    const products = currentProducts.slice(0, 8).map((item) => {
      const expected = expectedFields(item);
      return {
        productIdentityId: item.productIdentityId,
        title: item.productTitle || "Trading card product",
lifecycleState: "echo",
sourceLifecycleState: item.sourceLifecycleState,
alertChannel: "echo",
availabilityScope: item.locationId ? "physical_branch" : "physical_retailer_chain",
physicalEvidenceState: item.physicalEvidenceState,
status: item.localStockStatus,
        localState: consumerLocalState(item),
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
        ...expected,
        note: text(item.evidence?.note),
        sourceLabel: text(item.evidence?.sourceLabel || item.evidence?.source_label),
        value: item.value,
      };
    });

    const strongestExpected = expectedFields(strongest);
    return {
      ...shop,
      localStockStatus: strongest.localStockStatus,
      localStockEvidence: {
lifecycleState: "echo",
sourceLifecycleState: strongest.sourceLifecycleState,
alertChannel: "echo",
availabilityScope: strongest.locationId ? "physical_branch" : "physical_retailer_chain",
physicalEvidenceState: strongest.physicalEvidenceState,
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
        ...strongestExpected,
        note: text(strongest.evidence?.note),
        sourceLabel: text(strongest.evidence?.sourceLabel || strongest.evidence?.source_label),
        verifiedBranchStock: isVerifiedBranchStock(strongest),
      },
      localStockProducts: products,
      localAvailability: localAvailabilityProjection(products),
    };
  });
}

export function localStockCounts(shops = []) {
  return (shops || []).reduce((counts, shop) => {
    if (shop.localStockStatus === "in_stock") counts.inStock += 1;
    else if (shop.localStockStatus === "low_stock") counts.lowStock += 1;
else if (["incoming_watch", "reported_watch"].includes(shop.localStockStatus)) counts.incomingWatch += 1;
    return counts;
  }, { inStock: 0, lowStock: 0, incomingWatch: 0 });
}

export const LOCAL_STOCK_POLICY = Object.freeze({
  lifecycleStates: ["echo"],
  legacyStoredLifecycleStates: [...STORED_LOCAL_SIGNAL_KINDS],
  physicalEvidenceStates: [...PHYSICAL_EVIDENCE_STATES],
  officialEvidenceLevels: [...OFFICIAL_EVIDENCE_LEVELS],
  consumerStates: ["expected", "confirmed", "unknown"],
  expectedStockDisclaimer: EXPECTED_STOCK_DISCLAIMER,
  communityRule: "Community, staff, manual or social evidence is Echo · Reported and cannot become verified without fresh exact-branch retailer/API evidence.",
  chainIntelRule: "Retailer-chain allocation intelligence is Echo · Expected and remains advisory until exact-branch evidence exists.",
  identityRule: "Physical verified stock remains Echo · In-store confirmed; it requires canonical product identity and an exact branch match and never becomes Manifested.",
  rrpRule: "Local Radar uses the shared canonical RRP and price-intelligence engine; retailer selling price is never learned as RRP.",
  expiryRule: "Stale or explicitly unavailable physical evidence becomes Echo · No longer confirmed; it never creates ordinary Vanished.",
  contradictionRule: "Recent contradictory physical evidence reduces confidence and can force the current state to unknown.",
  shelfSightingTtlMinutes: EVIDENCE_TTL_MS.verified_shelf_sighting / 60_000,
  echoTtlHours: DEFAULT_TTL_MS.echo / 3_600_000,
});
