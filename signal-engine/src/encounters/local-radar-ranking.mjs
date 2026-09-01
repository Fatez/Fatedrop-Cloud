function text(value) {
  return String(value ?? "").trim();
}

function finiteDistance(shop) {
  const value = Number(shop?.distanceMiles);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function physicalEvidenceState(shop) {
  const candidates = [
    shop?.localStockEvidence?.physicalEvidenceState,
    shop?.localAvailability?.evidenceState,
    ...(Array.isArray(shop?.localStockProducts) ? shop.localStockProducts.map((item) => item?.physicalEvidenceState) : []),
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").toLowerCase();
    if (["verified", "reported", "expected", "expired"].includes(value)) return value;
  }
  if (shop?.localAvailability?.status === "confirmed") return "verified";
  if (shop?.localAvailability?.status === "expected") return "expected";
  return "unknown";
}

function priority(shop) {
  return ({ verified: 0, expected: 1, reported: 2, expired: 3, unknown: 4 })[physicalEvidenceState(shop)] ?? 4;
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
