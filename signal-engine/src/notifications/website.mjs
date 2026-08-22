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
  return Boolean(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL && process.env.FATEDROP_METRICS_INGEST_SECRET);
}

function lifecycleFor(signal) {
  if (LIFECYCLE_STATES.has(signal?.state)) return signal.state;
  return LEGACY_STATE_TO_LIFECYCLE.get(signal?.state) || null;
}

function evidenceSignalKind(signal) {
  if (!Array.isArray(signal?.evidence)) return null;
  const explicit = signal.evidence.find((entry) => entry && entry.kind === "signal_kind" && typeof entry.value === "string");
  if (explicit && PRECISE_KINDS.has(explicit.value)) return explicit.value;
  const readiness = signal.evidence.find((entry) => entry && entry.kind === "retailer_readiness" && ["queue", "security", "access_blocked"].includes(entry.state));
  return readiness?.state || null;
}

function signalKind(signal, lifecycle) {
  if (typeof signal?.kind === "string" && PRECISE_KINDS.has(signal.kind)) return signal.kind;
  const fromEvidence = evidenceSignalKind(signal);
  if (fromEvidence) return fromEvidence;
  if (["queue", "security", "access_blocked", "price_change", "launch_date_change"].includes(signal?.state)) return signal.state;

  const reason = String(signal?.reason || "").toLowerCase();
  if (lifecycle === "whisper") {
    if (reason.includes("state changed")) return "catalogue_state_change";
    if (reason.includes("activity observed") || reason.includes("catalogue product discovered")) return "catalogue_new";
  }
  if (lifecycle === "manifested") {
    if (reason.includes("returned to verified availability")) return "restock";
    if (reason.includes("new catalogue product")) return "new_listing_live";
    if (reason.includes("availability became verified")) return "availability_live";
  }
  if (lifecycle === "vanished" && reason.includes("no longer verified available")) return "sold_out";
  return "lifecycle_unspecified";
}

function signalIntensity({ lifecycle, kind, confidence }) {
  if (lifecycle === "echo" && ["queue", "security"].includes(kind)) return "major";
  if (lifecycle === "manifested" || lifecycle === "echo") return "standard";
  if (Number(confidence || 0) >= 0.9) return "standard";
  return "subtle";
}

function snapshotSignal(signal) {
  const lifecycle = lifecycleFor(signal);
  if (!lifecycle) return null;
  const kind = signalKind(signal, lifecycle);
  return {
    id: signal.id,
    state: lifecycle,
    kind,
    intensity: signalIntensity({ lifecycle, kind, confidence: signal.confidence }),
    confidence: signal.confidence ?? null,
    title: signal.title,
    retailer: signal.retailerName || signal.retailerId || null,
    detail: signal.reason || null,
    deliveredPricePence: signal.deliveredPricePence ?? signal.pricePence ?? null,
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
  if (!product || !offer) return null;
  const lifecycle = lifecycleFor(signal);
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
      stockStatus: offer.stockStatus,
      stockQuantity: offer.stockQuantity,
      firstSeenAt: offer.firstSeenAt,
      lastSeenAt: offer.lastSeenAt,
    },
    signal: {
      id: signal.id,
      state: lifecycle || signal.state,
      kind: lifecycle ? signalKind(signal, lifecycle) : null,
      detectedAt: signal.detectedAt,
      reason: signal.reason ?? null,
      confidence: signal.confidence ?? null,
      evidence: signal.evidence ?? [],
    },
  };
}

export async function publishWebsiteSnapshot({ store, source = DEFAULT_SOURCE, fetchImpl = fetch } = {}) {
  if (!configured()) return { published: false, reason: "not_configured" };
  if (!store) return { published: false, reason: "store_missing" };

  const measuredAt = Math.floor(Date.now() / 1000);
  const [stats, signals, retailers, products] = await Promise.all([
    store.stats(),
    store.listSignals({ since: measuredAt - 86_400, limit: 100 }),
    store.listRetailers(),
    typeof store.listProducts === "function" ? store.listProducts({ limit: 2000 }) : [],
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
      throw new Error(`Website snapshot publish failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    const result = await response.json().catch(() => ({}));
    return {
      published: true,
      stored: result.stored ?? null,
      measuredAt,
      signals: recentSignals.length,
      rrpReferenceProducts: rrpReferenceProducts.length,
      rrpReferenceProcessed: result.rrpReferenceProcessed ?? 0,
      opportunities: opportunities.length,
      fateMatchesTriggered: result.fateMatchesTriggered ?? 0,
    };
  } catch (error) {
    console.error("[website] snapshot publish failed", String(error?.message || error));
    return { published: false, reason: "publish_failed", error: String(error?.message || error) };
  }
}
