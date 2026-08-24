function finiteEpoch(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function roundedMean(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function windowKey(signal) {
  if (signal?.offerId) return `offer:${signal.offerId}`;
  if (signal?.retailerId && signal?.productId) return `fallback:${signal.retailerId}:${signal.productId}`;
  return null;
}

function confidenceForSamples(sampleCount) {
  if (sampleCount <= 0) return "none";
  if (sampleCount < 3) return "low";
  if (sampleCount < 6) return "medium";
  return "high";
}

function trendForWindows(windows) {
  if (windows.length < 6) return { direction: "insufficient_data", recentMedianSeconds: null, previousMedianSeconds: null, changePercent: null };
  const completedDesc = [...windows].sort((a, b) => b.endedAt - a.endedAt);
  const recentMedianSeconds = median(completedDesc.slice(0, 3).map((window) => window.durationSeconds));
  const previousMedianSeconds = median(completedDesc.slice(3, 6).map((window) => window.durationSeconds));
  if (!Number.isFinite(recentMedianSeconds) || !Number.isFinite(previousMedianSeconds) || previousMedianSeconds <= 0) {
    return { direction: "insufficient_data", recentMedianSeconds, previousMedianSeconds, changePercent: null };
  }
  const changePercent = Math.round(((recentMedianSeconds - previousMedianSeconds) / previousMedianSeconds) * 100);
  const direction = changePercent <= -20 ? "faster" : changePercent >= 20 ? "slower" : "stable";
  return { direction, recentMedianSeconds, previousMedianSeconds, changePercent };
}

function summarizeWindows(windows) {
  const durations = windows.map((window) => window.durationSeconds).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    sampleCount: durations.length,
    sampleConfidence: confidenceForSamples(durations.length),
    typicalAvailabilitySeconds: median(durations),
    averageAvailabilitySeconds: roundedMean(durations),
    shortestAvailabilitySeconds: durations.length ? Math.min(...durations) : null,
    longestAvailabilitySeconds: durations.length ? Math.max(...durations) : null,
    trend: trendForWindows(windows),
  };
}

export function buildAvailabilityWindows(signals = [], { now = Math.floor(Date.now() / 1000) } = {}) {
  const ordered = [...signals]
    .filter((signal) => signal && ["manifested", "vanished"].includes(String(signal.state || "").toLowerCase()))
    .map((signal) => ({ ...signal, detectedAt: finiteEpoch(signal.detectedAt) }))
    .filter((signal) => signal.detectedAt != null)
    .sort((a, b) => a.detectedAt - b.detectedAt || String(a.id || "").localeCompare(String(b.id || "")));

  const activeByOffer = new Map();
  const completed = [];

  for (const signal of ordered) {
    const key = windowKey(signal);
    if (!key) continue;
    const state = String(signal.state || "").toLowerCase();

    if (state === "manifested") {
      if (!activeByOffer.has(key)) {
        activeByOffer.set(key, {
          productId: signal.productId || null,
          offerId: signal.offerId || null,
          retailerId: signal.retailerId || null,
          retailerName: signal.retailerName || null,
          title: signal.title || null,
          startedAt: signal.detectedAt,
          manifestedSignalId: signal.id || null,
          pricePence: Number.isFinite(Number(signal.pricePence)) ? Number(signal.pricePence) : null,
        });
      }
      continue;
    }

    const active = activeByOffer.get(key);
    if (!active || signal.detectedAt < active.startedAt) continue;
    completed.push({
      ...active,
      endedAt: signal.detectedAt,
      vanishedSignalId: signal.id || null,
      durationSeconds: signal.detectedAt - active.startedAt,
    });
    activeByOffer.delete(key);
  }

  const safeNow = finiteEpoch(now) ?? Math.floor(Date.now() / 1000);
  const active = [...activeByOffer.values()]
    .map((window) => ({ ...window, observedLiveForSeconds: Math.max(0, safeNow - window.startedAt) }))
    .sort((a, b) => b.startedAt - a.startedAt);

  return {
    completed: completed.sort((a, b) => b.endedAt - a.endedAt),
    active,
  };
}

export function buildAvailabilityIntelligence(signals = [], { now = Math.floor(Date.now() / 1000) } = {}) {
  const windows = buildAvailabilityWindows(signals, { now });
  const byRetailerMap = new Map();
  for (const window of windows.completed) {
    const key = window.retailerId || "unknown";
    const group = byRetailerMap.get(key) || { retailerId: window.retailerId || null, retailerName: window.retailerName || null, windows: [] };
    group.windows.push(window);
    if (!group.retailerName && window.retailerName) group.retailerName = window.retailerName;
    byRetailerMap.set(key, group);
  }

  const byRetailer = [...byRetailerMap.values()]
    .map((group) => ({
      retailerId: group.retailerId,
      retailerName: group.retailerName,
      ...summarizeWindows(group.windows),
      lastCompletedWindow: [...group.windows].sort((a, b) => b.endedAt - a.endedAt)[0] || null,
    }))
    .sort((a, b) => b.sampleCount - a.sampleCount || String(a.retailerName || "").localeCompare(String(b.retailerName || "")));

  return {
    basis: "manifested_to_vanished",
    evidenceNote: "Availability duration is derived only from observed Manifested → Vanished windows. Open windows are excluded from averages.",
    ...summarizeWindows(windows.completed),
    completedWindows: windows.completed,
    activeWindows: windows.active,
    byRetailer,
  };
}

export async function loadAvailabilityIntelligence(store, {
  productId = null,
  offerId = null,
  retailerId = null,
  since = 0,
  limit = 500,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!productId && !offerId) throw new Error("productId or offerId is required");
  const safeLimit = Math.max(1, Math.min(2000, Number.parseInt(String(limit), 10) || 500));
  let signals;

  if (typeof store?.listAvailabilitySignals === "function") {
    signals = await store.listAvailabilitySignals({ productId, offerId, retailerId, since, limit: safeLimit });
  } else if (typeof store?.listSignals === "function") {
    const raw = await store.listSignals({
      states: ["manifested", "vanished"],
      retailerIds: retailerId ? [retailerId] : [],
      since,
      limit: safeLimit,
    });
    signals = raw.filter((signal) => (!productId || signal.productId === productId) && (!offerId || signal.offerId === offerId));
  } else {
    throw new Error("Store does not support signal history");
  }

  return buildAvailabilityIntelligence(signals, { now });
}
