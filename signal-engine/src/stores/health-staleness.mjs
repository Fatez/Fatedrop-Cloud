export const DEFAULT_RETAILER_STALE_AFTER_SECONDS = 30 * 60;

function epoch(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function effectiveRetailerHealth(retailer, {
  now = Math.floor(Date.now() / 1000),
  staleAfterSeconds = DEFAULT_RETAILER_STALE_AFTER_SECONDS,
} = {}) {
  const rawHealthy = retailer?.healthy === true;
  const lastSuccessAt = epoch(retailer?.lastSuccessAt) ?? (rawHealthy ? epoch(retailer?.lastScanAt) : null);
  const safeThreshold = Math.max(60, Number(staleAfterSeconds) || DEFAULT_RETAILER_STALE_AFTER_SECONDS);
  const stale = rawHealthy && (!lastSuccessAt || now - lastSuccessAt > safeThreshold);

  return {
    ...retailer,
    lastRunHealthy: rawHealthy,
    lastSuccessAt,
    stale,
    healthy: rawHealthy && !stale,
  };
}

export function decorateRetailerHealthStore(store, options = {}) {
  if (!store || typeof store.listRetailers !== "function") return store;
  const listRetailers = store.listRetailers.bind(store);
  store.listRetailers = async (...args) => {
    const retailers = await listRetailers(...args);
    return retailers.map((retailer) => effectiveRetailerHealth(retailer, options));
  };
  return store;
}
