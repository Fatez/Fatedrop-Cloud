import { catalogueCompletenessDecision, previousRetailerProductsSeen } from "../core/catalogue-completeness.mjs";

export const CATALOGUE_INCOMPLETE_ERROR_CODE = "catalogue_incomplete";

export function decorateCatalogueCompletenessStore(store) {
  if (!store || typeof store.saveScan !== "function" || typeof store.listRetailers !== "function") return store;

  const saveScan = store.saveScan.bind(store);
  const listRetailers = store.listRetailers.bind(store);

  store.saveScan = async (payload) => {
    const health = payload?.health || {};
    if (health.source !== "catalogue") return saveScan(payload);

    const retailers = await listRetailers();
    const previousProductsSeen = previousRetailerProductsSeen(retailers, payload?.retailer?.id);
    const decision = catalogueCompletenessDecision({
      retailer: payload?.retailer,
      observedProducts: health.productsSeen,
      previousProductsSeen,
    });

    if (!decision.acceptable) {
      const error = new Error(
        `Retailer catalogue scan quarantined: ${decision.reason} (observed=${decision.observed}, previous=${decision.previous ?? "unknown"}, expected=${decision.expected ?? "unknown"}).`,
      );
      error.code = CATALOGUE_INCOMPLETE_ERROR_CODE;
      error.catalogueCompleteness = decision;
      throw error;
    }

    return saveScan(payload);
  };

  return store;
}
