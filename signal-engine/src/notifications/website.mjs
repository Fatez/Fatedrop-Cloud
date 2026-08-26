import { signalCapabilities } from "../core/signal-policy.mjs";
import { buildSignalDeliveryReport, flattenSignalDeliveryMetrics } from "../telemetry/signal-delivery-report.mjs";
import { recordWebsiteSnapshotOutcome, websiteSnapshotConfigured } from "../telemetry/website-snapshot-health.mjs";

const DEFAULT_SOURCE = "FateDrop Signal Engine";
const LIFECYCLE_STATES = new Set(["whisper", "manifested", "vanished", "echo"]);
const PRECISE_KINDS = new Set([
  "catalogue_new",
  "catalogue_state_change",
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

function signalKind(signal) {
  if (typeof signal?.kind === "string" && PRECISE_KINDS.has(signal.kind)) return signal.kind;
  const fromEvidence = evidenceValue(signal, "signal_kind");
  if (fromEvidence && PRECISE_KINDS.has(fromEvidence)) return fromEvidence;
  return "lifecycle_unspecified";
}

function alertClass(signal) {
  if (signal?.alertClass === "primary_drop" || signal?.alertClass === "market_stock") return signal.alertClass;
  const fromEvidence = evidenceValue(signal, "signal_alert_class");
  if (fromEvidence === "primary_drop" || fromEvidence === "market_stock") return fromEvidence;
  return signalCapabilities(signal?.retailerId).alertClass;
}

function signalIntensity(signal) {
  const kind = signalKind(signal);
  if (signal.state === "echo" && ["queue", "security"].includes(kind)) return "major";
  if (signal.state === "manifested" || signal.state === "echo") return "standard";
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
  if (!LIFECYCLE_STATES.has(signal?.state)) return null;
  const pricing = pricingContext(signal);
  const retailerSku = signal?.retailerSku || evidenceValue(signal, "retailer_sku") || null;
  const retailerUrl = signal?.url || signal?.target?.productUrl || null;
  return {
    id: signal.id,
    state: signal.state,
    kind: signalKind(signal),
    alertClass: alertClass(signal),
    intensity: signalIntensity(signal),
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
  const [stats, signals, retailers, deliveryReport] = await Promise.all([
    store.stats(),
    store.listSignals({ since: measuredAt - 86_400, limit: 100 }),
    store.listRetailers(),
    buildSignalDeliveryReport(store, { since: measuredAt - 86_400, until: measuredAt + 1 }),
  ]);

  const relevantSignals = signals
    .filter((signal) => LIFECYCLE_STATES.has(signal.state))
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, 100);
  const recentSignals = relevantSignals.map(snapshotSignal).filter(Boolean);

  const healthyMonitors = retailers.filter((retailer) => retailer.healthy).length;
  const sourceEventId = `signal-engine:${measuredAt}:${recentSignals[0]?.id || "no-signals"}`;
  const payload = {
    sourceEventId,
    source,
    measuredAt,
    snapshotMode: "telemetry_only",
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
    // Historical receiver fields stay present as empty arrays for backwards
    // compatibility. Cloud is now the catalogue/True Price/FateMatch authority;
    // the periodic Web bridge must not replay a second product/offer catalogue.
    rrpReferenceProducts: [],
    opportunities: [],
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
      snapshotMode: "telemetry_only",
      rrpReferenceProducts: 0,
      rrpReferenceProcessed: 0,
      opportunities: 0,
      fateMatchesTriggered: 0,
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
