const DEFAULT_SOURCE = "FateDrop Signal Engine";

function configured() {
  return Boolean(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL && process.env.FATEDROP_METRICS_INGEST_SECRET);
}

function snapshotSignal(signal) {
  return {
    id: signal.id,
    state: signal.state,
    title: signal.title,
    retailer: signal.retailerName || signal.retailerId || null,
    detail: signal.reason || null,
    deliveredPricePence: signal.deliveredPricePence ?? signal.pricePence ?? null,
    occurredAt: signal.detectedAt,
  };
}

export async function publishWebsiteSnapshot({ store, source = DEFAULT_SOURCE, fetchImpl = fetch } = {}) {
  if (!configured()) return { published: false, reason: "not_configured" };
  if (!store) return { published: false, reason: "store_missing" };

  const measuredAt = Math.floor(Date.now() / 1000);
  const [stats, signals, retailers] = await Promise.all([
    store.stats(),
    store.listSignals({ since: measuredAt - 86_400, limit: 100 }),
    store.listRetailers(),
  ]);

  const recentSignals = signals
    .filter((signal) => ["whisper", "manifested", "vanished", "echo"].includes(signal.state))
    .sort((a, b) => b.detectedAt - a.detectedAt)
    .slice(0, 100)
    .map(snapshotSignal);

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
    return { published: true, stored: result.stored ?? null, measuredAt, signals: recentSignals.length };
  } catch (error) {
    console.error("[website] snapshot publish failed", String(error?.message || error));
    return { published: false, reason: "publish_failed", error: String(error?.message || error) };
  }
}
