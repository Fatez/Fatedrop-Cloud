function text(value) {
  return String(value ?? "").trim();
}

function finiteDistance(shop) {
  const value = Number(shop?.distanceMiles);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function hasExpectedStock(shop) {
  if (shop?.localAvailability?.expected) return true;
  if (shop?.localAvailability?.status === "expected") return true;
  return Array.isArray(shop?.localStockProducts)
    && shop.localStockProducts.some((item) => item?.localState === "expected");
}

function priority(shop) {
  if (shop?.localAvailability?.status === "confirmed") return 0;
  if (hasExpectedStock(shop)) return 1;
  return 2;
}

export function prioritizeLocalRadarShops(shops = []) {
  return [...(Array.isArray(shops) ? shops : [])].sort((a, b) => {
    const priorityDifference = priority(a) - priority(b);
    if (priorityDifference) return priorityDifference;

    const distanceDifference = finiteDistance(a) - finiteDistance(b);
    if (Number.isFinite(distanceDifference) && distanceDifference) return distanceDifference;

    const nameDifference = text(a?.name).localeCompare(text(b?.name), "en-GB", { sensitivity: "base" });
    if (nameDifference) return nameDifference;

    return text(a?.id).localeCompare(text(b?.id), "en-GB", { sensitivity: "base" });
  });
}
