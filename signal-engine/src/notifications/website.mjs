import { signalCapabilities } from "../core/signal-policy.mjs";
import { buildSignalDeliveryReport, flattenSignalDeliveryMetrics } from "../telemetry/signal-delivery-report.mjs";
import { recordWebsiteSnapshotOutcome, websiteSnapshotConfigured } from "../telemetry/website-snapshot-health.mjs";

const DEFAULT_SOURCE = "FateDrop Signal Engine";
const LIFECYCLE_STATES = new Set(["whisper", "manifested", "vanished", "echo"]);
const LEGACY_STATE_TO_LIFECYCLE = new Map([
  ["queue", "echo"],
  ["security", "echo"],
  ["access_blocked", "echo"],
  ["price_change", "whisper"],
  ["launch_date_change", "whisper"],
]);
const PRECISE_KINDS = new Set([
  "catalogue_new",
  "catalogue_state_change",
  "price_change",
  "launch_date_change",
  "queue",
  "security",
  "access_blocked",
  "new_listing_live",
  "availability_live",
  "restock",
  "sold_out",
  "lifecycle_unspecified",
]);

function configured() {
  return websiteSnapshotConfigured();
}

function evidenceValue(signal, kind) {
  if (!Array.isArray(signal?.evidence)) return null;
  const entry = signal.evidence.find((item) => item && item.kind === kind && typeof item.value === "string");
  return entry?.value || null;
}

function lifecycleFor(signal) {
  if (LIFECYCLE_STATES.has(signal?.state)) return signal.state;
  return LEGACY_STATE_TO_LIFECYCLE.get(signal?.state) || null;
}

function evidenceSignalKind(signal, lifecycle) {
  if (!Array.isArray(signal?.evidence)) return null;
  const explicitKinds = signal.evidence.filter((entry) => entry && entry.kind === "signal_kind" && typeof entry.value === "string" && PRECISE_KINDS.has(entry.value));
  const lifecycleMatch = explicitKinds.find((entry) => entry.lifecycle === lifecycle);
  if (lifecycleMatch) return lifecycleMatch.value;
  if (lifecycle === "echo") {
    const readiness = signal.evidence.find((entry) => entry && entry.kind === "retailer_readiness" && ["queue", "security", "access_blocked"].includes(entry.state));
    if (readiness) return readiness.state;
  }
  return explicitKinds.find((entry) => !entry.lifecycle)?.value || null;
}

function signalKind(signal, lifecycle = lifecycleFor(signal)) {
  if (typeof signal?.kind === "string" && PRECISE_KINDS.has(signal.kind)) return signal.kind;
  const fromEvidence = evidenceSignalKind(signal, lifecycle);
  if (fromEvidence) return fromEvidence;
  if (["queue", "security", "access_blocked", "price_change", "launch_date_change"].includes(signal?.state)) return signal.state;

  const reason = String(signal?.reason || "").toLowerCase();
  if (lifecycle === "whisper") {
    if (reason.includes("state changed")) return "catalogue_state_change";
    if (reason.includes("activity observed") || reason.includes("catalogue product discovered") || reason.includes("retailer sku/catalogue activity")) return "catalogue_new";
  }
  if (lifecycle === "manifested") {
    if (reason.includes("returned to verified availability")) return "restock";
    if (reason.includes("new catalogue product") || reason.includes("new retailer sku")) return "new_listing_live";
    if (reason.includes("availability became verified")) return "availability_live";
  }
  if (lifecycle === "vanished" && (reason.includes("no longer verified available") || reason.includes("no longer verified"))) return "sold_out";
  return "lifecycle_unspecified";
}

function alertClass(signal) {
  if (signal?.alertClass === "primary_drop" || signal?.alertClass === "market_stock") return signal.alertClass;
  const fromEvidence = evidenceValue(signal, "signal_alert_class");
  if (fromEvidence === "primary_drop" || fromEvidence === "market_stock") return fromEvidence;
  return signalCapabilities(signal?.retailerId).alertClass;
}

function signalIntensity(signal, lifecycle = lifecycleFor(signal)) {
  const kind = signalKind(signal, lifecycle);
  if (lifecycle === "echo" && ["queue", "security"].includes(kind)) return "major";
  if (lifecycle === "manifested" || lifecycle === "echo") return "standard";
  return Number(signal.confidence || 0) >= 0.9 ? "standard" : "subtle";
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function pricingContext(signal) {
  const pricePence = finiteOrNull(signal?.pricePence);
  const rrpPence = finiteOrNull(signal?.rrpPence);
  const postagePence = finiteOrNull(signal?.postagePence);
  const deliveredPricePence = finiteOrNull(signal?.deliveredPricePence)
    ?? (pricePence !== null && postagePence !== null ? pricePence + postagePence : null);
  const markupPercent = finiteOrNull(signal?.markupPercent)
    ?? (pricePence !== null && rrpPence !== null && rrpPence > 0 ? ((pricePence - rrpPence) / rrpPence) * 100 : null);

  let rrpPosition = "unknown";
  if (markupPercent !== null) {
    if (Math.abs(markupPercent) <= 1) rrpPosition = "at_rrp";
    else if (markupPercent < 0) rrpPosition = "below_rrp";
    else rrpPosition = "above_rrp";
  }

  return { pricePence, rrpPence, postagePence, deliveredPricePence, markupPercent, rrpPosition };
}

function snapshotSignal(signal) {
  const lifecycle = lifecycleFor(signal);
  if (!lifecycle) return null;
  const pricing = pricingContext(signal);
  const retailerSku = signal?.retailerSku || evidenceValue(signal, "retailer_sku") || null;
  const retailerUrl = signal?.url || signal?.target?.productUrl || null;
  return {
    id: signal.id,
    state: lifecycle,
    kind: signalKind(signal, lifecycle),
    alertClass: alertClass(signal),
    intensity: signalIntensity(signal, lifecycle),
    confidence: signal.confidence ?? null,
    productId: signal.productId ?? signal.target?.productId ?? null,
    offerId: signal.offerId ?? signal.target?.offerId ?? null,
    retailerId: signal.retailerId ?? signal.target?.retailerId ?? null,
    retailerSku,
    title: signal.title,
    retailer: signal.retailerName || signal.retailerId || null,
    detail: signal.reason || null,
    retailerUrl,
    imageUrl: signal.imageUrl ?? null,
    stockStatus: signal.stockStatus ?? null,
    pricePence: pricing.pricePence,
    rrpPence: pricing.rrpPence,
    postagePence: pricing.postagePence,
    deliveredPricePence: pricing.deliveredPricePence,
    markupPercent: pricing.markupPercent,
    rrpPosition: pricing.rrpPosition,
    occurredAt: signal.detectedAt,
  };
}

function rrpReferenceProduct(product) {
  if (!product?.id || !product?.canonicalKey || !product?.title || product.officialRrpPence == null || !product.rrpSource) return null;
  return {
    id: product.id,
    canonicalKey: product.canonicalKey,
    title: product.title,
    productType: product.productType ?? null,
    tcg: product.tcg || "pokemon",
    officialRrpPence: product.officialRrpPence,
    rrpSource: product.rrpSource,
    rrpObservedAt: product.rrpObservedAt ?? null,
  };
}

async function networkOpportunity(store, signal) {
  const [product, offer] = await Promise.all([
    signal.productId ? store.getProduct(signal.productId) : null,
    signal.offerId ? store.getOffer(signal.offerId) : null,
  ]);
  const lifecycle = lifecycleFor(signal);
  if (!product || !offer || !lifecycle) return null;
  const context = pricingContext({
    ...signal,
    pricePence: signal.pricePence ?? offer.pricePence,
    rrpPence: signal.rrpPence ?? product.officialRrpPence,
    postagePence: signal.postagePence ?? offer.postagePence,
  });
  return {
    retailer: {
      id: offer.retailerId,
      name: offer.retailerName,
    },
    product: {
      id: product.id,
      canonicalKey: product.canonicalKey,
      title: product.title,
      productType: product.productType,
      tcg: product.tcg || "pokemon",
      officialRrpPence: product.officialRrpPence ?? null,
      rrpSource: product.rrpSource ?? null,
      rrpObservedAt: product.rrpObservedAt ?? null,
    },
    offer: {
      offerId: offer.offerId,
      productId: offer.productId,
      retailerId: offer.retailerId,
      retailerName: offer.retailerName,
      retailerSku: offer.retailerSku,
      title: offer.title,
      url: offer.url,
      imageUrl: offer.imageUrl,
      pricePence: offer.pricePence,
      postagePence: offer.postagePence,
      deliveredPricePence: context.deliveredPricePence,
      officialRrpPence: context.rrpPence,
      markupPercent: context.markupPercent,
      rrpPosition: context.rrpPosition,
      stockStatus: offer.stockStatus,
      stockQuantity: offer.stockQuantity,
      firstSeenAt: offer.firstSeenAt,
      lastSeenAt: offer.lastSeenAt,
    },
    signal: {
      id: signal.id,
      state: lifecycle,
      kind: signalKind(signal, lifecycle),
      alertClass: alertClass(signal),
      detectedAt: signal.detectedAt,
      reason: signal.reason ?? null,
      confidence: signal.confidence ?? null,
      retailerSku: signal.retailerSku || evidenceValue(signal, "retailer_sku") || offer.retailerSku || null,
      retailerUrl: signal.url || offer.url || null,
      evidence: signal.evidence ?? [],
    },
  };
}

export async function publishWebsiteSnapshot({ store, source = DEFAULT_SOURCE, fetchImpl = fetch } = {}) {
  if (!configured()) {
    const outcome = { published: false, reason: "not_configured" };
    recordWebsiteSnapshotOutcome(outcome);
    return outcome;
  }
  if (!store) {
    const outcome = { published: false, reason: "store_missing" };
    recordWebsiteSnapshotOutcome(outcome);
    return outcome;
  }

  const measuredAt = Math.floor(Date.now() / 1000);
  const [stats, signals, retailers, products, deliveryReport] = await Promise.all([
    store.stats(),
    store.listSignals({ since: measuredAt - 86_400, limit: 100 }),
    store.listRetailers(),
    typeof store.listProducts === "function" ? store.listProducts({ limit: 2000 }) : [],
    buildSignalDeliveryReport(store, { since: measuredAt - 86_400, until: measuredAt + 1 }),
  ]);

  const relevantSignals = signals
    .map((signal) => ({ source: signal, snapshot: snapshotSignal(signal) }))
    .filter((entry) => entry.snapshot)
    .sort((a, b) => b.snapshot.occurredAt - a.snapshot.occurredAt)
    .slice(0, 100);
  const recentSignals = relevantSignals.map((entry) => entry.snapshot);
  const opportunities = (await Promise.all(relevantSignals.map((entry) => networkOpportunity(store, entry.source).catch(() => null)))).filter(Boolean);
  const rrpReferenceProducts = products.map(rrpReferenceProduct).filter(Boolean).slice(0, 2000);

  const healthyMonitors = retailers.filter((retailer) => retailer.healthy).length;
  const sourceEventId = `signal-engine:${measuredAt}:${recentSignals[0]?.id || "no-signals"}`;
  const payload = {
    sourceEventId,
    source,
    measuredAt,
    metrics: {
      whisper: stats.whisper24h ?? null,
      manifested: stats.manifested24h ?? null,
      vanished: stats.vanished24h ?? null,
      echo: stats.echo24h ?? null,
      changes24h: stats.signals24h ?? null,
      productsTracked: stats.productsTracked ?? null,
      inStock: stats.currentlyAvailable ?? null,
      catalogueRetailers: retailers.length,
      healthyMonitors,
      ...flattenSignalDeliveryMetrics(deliveryReport),
    },
    recentSignals,
    rrpReferenceProducts,
    opportunities,
    upcomingEvents: [],
  };

  try {
    const response = await fetchImpl(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FATEDROP_METRICS_INGEST_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const outcome = {
        published: false,
        reason: "publish_failed",
        httpStatus: response.status,
        error: `Website snapshot publish failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
      };
      console.error("[website] snapshot publish failed", outcome.error);
      recordWebsiteSnapshotOutcome(outcome, { attemptedAt: measuredAt });
      return outcome;
    }
    const result = await response.json().catch(() => ({}));
    const outcome = {
      published: true,
      stored: result.stored ?? null,
      measuredAt,
      signals: recentSignals.length,
      delivery: deliveryReport.available ? deliveryReport.totals : null,
      rrpReferenceProducts: rrpReferenceProducts.length,
      rrpReferenceProcessed: result.rrpReferenceProcessed ?? 0,
      opportunities: opportunities.length,
      fateMatchesTriggered: result.fateMatchesTriggered ?? 0,
    };
    recordWebsiteSnapshotOutcome(outcome, { attemptedAt: measuredAt });
    return outcome;
  } catch (error) {
    const outcome = { published: false, reason: "publish_failed", error: String(error?.message || error) };
    console.error("[website] snapshot publish failed", outcome.error);
    recordWebsiteSnapshotOutcome(outcome, { attemptedAt: measuredAt });
    return outcome;
  }
}
