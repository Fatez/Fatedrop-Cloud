import { PriceQuality, classifyObservedPrice } from "./price-quality.mjs";

const VERSION = "retailer-pressure-v1";
const MAX_PRESSURE = 100;

const DRIVER_WEIGHTS = Object.freeze({
  official_retailer_product_page: 12,
  official_retailer_catalogue_listing: 10,
  stock_object_present: 7,
  inventory_metadata: 10,
  launch_metadata: 7,
  launch_date: 5,
  preorder_metadata: 5,
  future_release_known: 4,
  retailer_backend_exposed: 12,
  network_readiness: 12,
  queue_readiness: 16,
  security_readiness: 10,
  observation_repeated: 7,
});

const PRESSURE_ONLY_KINDS = new Set([
  "retailer_pressure_version",
  "retailer_pressure",
  "retailer_pressure_band",
  "retailer_pressure_delta",
  "retailer_pressure_attention",
  "retailer_pressure_scan_hint_seconds",
  "retailer_pressure_fingerprint",
  "retailer_pressure_driver",
]);

function clamp(value, min = 0, max = MAX_PRESSURE) {
  return Math.min(max, Math.max(min, value));
}

function evidenceEntries(offer) {
  return Array.isArray(offer?.evidence) ? offer.evidence : [];
}

function evidenceKinds(offer) {
  return new Set(evidenceEntries(offer)
    .map((entry) => String(entry?.kind || "").trim())
    .filter((kind) => kind && !PRESSURE_ONLY_KINDS.has(kind)));
}

function evidenceNumber(offer, kind) {
  const entry = evidenceEntries(offer).find((candidate) => candidate?.kind === kind);
  if (!entry) return null;
  const value = Number(entry.value);
  return Number.isFinite(value) ? value : null;
}

function hasStructuredCatalogue(kinds) {
  return [...kinds].some((kind) => /(?:shopify|woocommerce|structured|catalogue|product_page|retailer_sku)/i.test(kind));
}

function priceQuality(offer) {
  return classifyObservedPrice({
    pricePence: offer?.pricePence,
    retailerId: offer?.retailerId,
    evidence: evidenceEntries(offer),
  }).priceQuality;
}

function ageDecay(elapsedSeconds) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return 0;
  if (elapsedSeconds <= 120) return 0.82;
  if (elapsedSeconds <= 600) return 0.62;
  if (elapsedSeconds <= 1800) return 0.42;
  if (elapsedSeconds <= 3600) return 0.25;
  return 0.08;
}

function pressureBand(score) {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "elevated";
  if (score >= 20) return "watch";
  return "quiet";
}

function attentionForBand(band) {
  if (band === "critical") return { mode: "burst", suggestedScanCadenceSeconds: 60 };
  if (band === "high") return { mode: "burst", suggestedScanCadenceSeconds: 90 };
  if (band === "elevated") return { mode: "elevated", suggestedScanCadenceSeconds: 180 };
  if (band === "watch") return { mode: "standard", suggestedScanCadenceSeconds: 300 };
  return { mode: "passive", suggestedScanCadenceSeconds: null };
}

function addDriver(drivers, name, weight) {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  drivers.push({ name, weight });
  return weight;
}

function basePressure({ previousOffer = null, currentOffer, now }) {
  if (!currentOffer) return { score: 0, drivers: [] };
  const kinds = evidenceKinds(currentOffer);
  const previousKinds = evidenceKinds(previousOffer);
  const currentPriceQuality = priceQuality(currentOffer);
  const previousPriceQuality = previousOffer ? priceQuality(previousOffer) : null;
  const drivers = [];
  let score = 0;

  const identityComplete = Boolean(currentOffer.retailerId && currentOffer.retailerSku && currentOffer.title && currentOffer.url);
  if (identityComplete) score += addDriver(drivers, "identity_complete", 4);
  if (hasStructuredCatalogue(kinds)) score += addDriver(drivers, "structured_catalogue", 8);
  if (!previousOffer) score += addDriver(drivers, "new_retailer_sku", 7);

  for (const [kind, weight] of Object.entries(DRIVER_WEIGHTS)) {
    if (kinds.has(kind)) score += addDriver(drivers, kind, weight);
  }

  const cluster = evidenceEntries(currentOffer).find((entry) => entry?.kind === "retailer_preparation_cluster");
  if (cluster) {
    const leader = cluster.clusterLeader === true || cluster.leaderOfferId === currentOffer.offerId;
    score += addDriver(drivers, leader ? "preparation_cluster_leader" : "preparation_cluster_member", leader ? 18 : 5);
  }

  if (currentPriceQuality === PriceQuality.PLACEHOLDER) {
    score += addDriver(drivers, "placeholder_price", 10);
  }
  if (previousOffer && previousPriceQuality === PriceQuality.PLACEHOLDER && currentPriceQuality === PriceQuality.VALID) {
    score += addDriver(drivers, "placeholder_to_commercial_price", 18);
  }

  if (previousOffer && previousOffer.stockStatus !== currentOffer.stockStatus) {
    score += addDriver(drivers, "stock_state_transition", 7);
  }
  if (previousOffer
    && Number.isFinite(previousOffer.stockQuantity)
    && Number.isFinite(currentOffer.stockQuantity)
    && previousOffer.stockQuantity !== currentOffer.stockQuantity) {
    score += addDriver(drivers, "inventory_quantity_transition", 8);
  }

  const firstSeenAt = Number(currentOffer.firstSeenAt);
  const lastSeenAt = Number(previousOffer?.lastSeenAt);
  if (previousOffer && Number.isFinite(firstSeenAt) && firstSeenAt > 0 && Number.isFinite(lastSeenAt) && lastSeenAt >= firstSeenAt) {
    const ageBeforeThisScan = Math.max(0, lastSeenAt - firstSeenAt);
    const ageNow = Math.max(0, Number(now) - firstSeenAt);
    if (ageBeforeThisScan < 60 && ageNow >= 60) score += addDriver(drivers, "survived_first_minute", 6);
    if (ageBeforeThisScan < 300 && ageNow >= 300) score += addDriver(drivers, "survived_five_minutes", 5);
  }

  if (previousOffer && previousKinds.size > 0) {
    const newlyAppearedKinds = [...kinds].filter((kind) => !previousKinds.has(kind));
    const meaningfulNewKinds = newlyAppearedKinds.filter((kind) => kind in DRIVER_WEIGHTS);
    if (meaningfulNewKinds.length >= 2) {
      score += addDriver(drivers, "multi_evidence_acceleration", Math.min(12, meaningfulNewKinds.length * 4));
    }
  }

  return { score: clamp(score), drivers };
}

export function deriveRetailerPressure({ previousOffer = null, currentOffer, now = Math.floor(Date.now() / 1000) } = {}) {
  const base = basePressure({ previousOffer, currentOffer, now });
  const persistedPreviousPressure = evidenceNumber(previousOffer, "retailer_pressure");
  const previousBase = previousOffer ? basePressure({ previousOffer: null, currentOffer: previousOffer, now: Number(previousOffer.lastSeenAt) || now }).score : 0;
  const previousPressure = persistedPreviousPressure ?? previousBase;
  const elapsedSeconds = previousOffer ? Math.max(0, Number(now) - Number(previousOffer.lastSeenAt || now)) : null;
  const inheritedPressure = previousOffer ? previousPressure * ageDecay(elapsedSeconds) : 0;

  // Pressure is deliberately advisory. Historical pressure decays; fresh observable
  // retailer behaviour can raise it. It never changes stock truth or purchaseability.
  const score = clamp(Math.round(Math.max(base.score, inheritedPressure)));
  const delta = previousOffer ? score - Math.round(previousPressure) : score;
  const band = pressureBand(score);
  const attention = attentionForBand(band);
  const drivers = [...base.drivers].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const fingerprint = drivers.slice(0, 6).map((driver) => driver.name).join("+") || "none";

  return {
    version: VERSION,
    score,
    previousScore: previousOffer ? Math.round(previousPressure) : null,
    delta,
    band,
    attentionMode: attention.mode,
    suggestedScanCadenceSeconds: attention.suggestedScanCadenceSeconds,
    fingerprint,
    drivers,
  };
}

export function retailerPressureEvidence(pressure, observedAt = Math.floor(Date.now() / 1000)) {
  if (!pressure) return [];
  return [
    { kind: "retailer_pressure_version", value: pressure.version, observedAt },
    { kind: "retailer_pressure", value: String(pressure.score), observedAt },
    { kind: "retailer_pressure_band", value: pressure.band, observedAt },
    { kind: "retailer_pressure_delta", value: String(pressure.delta), observedAt },
    { kind: "retailer_pressure_attention", value: pressure.attentionMode, observedAt },
    ...(Number.isFinite(pressure.suggestedScanCadenceSeconds)
      ? [{ kind: "retailer_pressure_scan_hint_seconds", value: String(pressure.suggestedScanCadenceSeconds), observedAt }]
      : []),
    { kind: "retailer_pressure_fingerprint", value: pressure.fingerprint, observedAt },
    ...pressure.drivers.map((driver) => ({
      kind: "retailer_pressure_driver",
      value: driver.name,
      weight: driver.weight,
      observedAt,
    })),
  ];
}

export function summarizeRetailerPressure(readings = []) {
  const usable = (Array.isArray(readings) ? readings : []).filter((reading) => Number.isFinite(reading?.score));
  if (!usable.length) return { max: 0, band: "quiet", attentionMode: "passive", suggestedScanCadenceSeconds: null, fingerprints: [] };
  const strongest = [...usable].sort((a, b) => b.score - a.score)[0];
  return {
    max: strongest.score,
    band: strongest.band,
    attentionMode: strongest.attentionMode,
    suggestedScanCadenceSeconds: strongest.suggestedScanCadenceSeconds,
    fingerprints: [...new Set(usable.filter((reading) => reading.score >= 40).map((reading) => reading.fingerprint))].slice(0, 8),
  };
}
