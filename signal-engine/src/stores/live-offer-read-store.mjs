function liveRetailerIds(rows = []) {
  return new Set(
    rows
      .filter((row) => row?.healthy === true && row?.stale !== true)
      .map((row) => String(row?.id || "").trim())
      .filter(Boolean),
  );
}

/**
 * Consumer-facing offer reads must never treat preserved last-good catalogue
 * rows from an unhealthy/stale retailer as live availability.
 *
 * The underlying store remains untouched for monitoring/history. This proxy
 * only filters listOffers(), using the effective health returned by the
 * decorated store (raw health + the canonical 30-minute staleness rule).
 * If retailer health cannot be read, offer reads fail closed to an empty list.
 */
export function createLiveOfferReadStore(store) {
  if (!store || typeof store.listOffers !== "function" || typeof store.listRetailers !== "function") {
    throw new TypeError("createLiveOfferReadStore requires listOffers and listRetailers");
  }

  const listOffers = async (options) => {
    try {
      const [offers, retailers] = await Promise.all([
        store.listOffers(options),
        store.listRetailers(),
      ]);
      const liveIds = liveRetailerIds(retailers);
      return (Array.isArray(offers) ? offers : []).filter((offer) => liveIds.has(String(offer?.retailerId || "")));
    } catch {
      return [];
    }
  };

  return new Proxy(store, {
    get(target, property) {
      if (property === "listOffers") return listOffers;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const __test = { liveRetailerIds };
