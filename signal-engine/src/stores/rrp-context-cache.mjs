export const DEFAULT_RRP_CONTEXT_CACHE_MS = 5 * 60 * 1000;

export function decorateRrpContextReadCache(store, {
  ttlMs = DEFAULT_RRP_CONTEXT_CACHE_MS,
  now = () => Date.now(),
} = {}) {
  if (!store || typeof store.listProducts !== "function") return store;
  if (store.__fatedropRrpContextCache === true) return store;

  const listProducts = store.listProducts.bind(store);
  const safeTtlMs = Math.max(30_000, Number(ttlMs) || DEFAULT_RRP_CONTEXT_CACHE_MS);
  let cachedRows = null;
  let cachedAt = 0;
  let inFlight = null;

  store.listProducts = async (options = {}) => {
    const limit = Number(options?.limit ?? 2000);
    const broadRrpContextRead = (options?.rrpSource == null || options?.rrpSource === "") && limit >= 5000;
    if (!broadRrpContextRead) return listProducts(options);

    const observedAt = Number(now());
    if (cachedRows && Number.isFinite(observedAt) && observedAt - cachedAt < safeTtlMs) return cachedRows;
    if (inFlight) return inFlight;

    inFlight = Promise.resolve(listProducts(options))
      .then((rows) => {
        cachedRows = rows;
        cachedAt = Number(now());
        return rows;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  Object.defineProperty(store, "__fatedropRrpContextCache", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return store;
}
