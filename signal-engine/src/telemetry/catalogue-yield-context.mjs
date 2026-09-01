const catalogueYieldByRetailer = new Map();

export function recordCatalogueYield(retailerId, diagnostics = {}) {
  const id = String(retailerId || "").trim();
  if (!id) return;
  catalogueYieldByRetailer.set(id, {
    recordedAt: Math.floor(Date.now() / 1000),
    ...diagnostics,
  });
}

export function takeCatalogueYield(retailerId) {
  const id = String(retailerId || "").trim();
  if (!id || !catalogueYieldByRetailer.has(id)) return null;
  const diagnostics = catalogueYieldByRetailer.get(id);
  catalogueYieldByRetailer.delete(id);
  return diagnostics;
}

export function clearCatalogueYield(retailerId) {
  catalogueYieldByRetailer.delete(String(retailerId || "").trim());
}
