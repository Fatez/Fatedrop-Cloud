import { publicPresenceForRetailer } from "./presence.mjs";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicWebsite(retailer) {
  const candidate = text(retailer?.websiteUrl) || text(retailer?.baseUrl);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function verificationState(retailer) {
  if (typeof retailer?.verification === "string") return retailer.verification;
  return text(retailer?.verification?.status) || "unverified";
}

function tcgsFor(retailer) {
  const raw = Array.isArray(retailer?.tcgs) && retailer.tcgs.length ? retailer.tcgs : [retailer?.tcg || "pokemon"];
  return [...new Set(raw.map((value) => text(String(value)).toLowerCase()).filter(Boolean))];
}

export function buildPublicRetailerDirectory({ retailers = [], healthRows = [] } = {}) {
  const healthById = new Map((healthRows || []).map((health) => [health.id, health]));
  return (retailers || []).map((retailer) => {
    const health = healthById.get(retailer.id) || null;
    const presence = publicPresenceForRetailer(retailer);
    return {
      id: retailer.id,
      name: retailer.name,
      websiteUrl: publicWebsite(retailer),
      retailerClass: retailer.retailerClass || "independent",
      verification: verificationState(retailer),
      tcgs: tcgsFor(retailer),
      online: presence.online,
      physicalStores: presence.physicalStores,
      physicalLocations: presence.physicalLocations,
      monitoring: {
        configured: true,
        healthy: health?.healthy === true,
        stale: health?.stale === true,
        baselineCompleted: health?.baselineCompleted === true,
        productsSeen: Number.isFinite(health?.productsSeen) ? health.productsSeen : null,
        lastScanAt: Number.isFinite(health?.lastScanAt) ? health.lastScanAt : null,
        lastSuccessAt: Number.isFinite(health?.lastSuccessAt) ? health.lastSuccessAt : null,
      },
    };
  }).sort((a, b) => {
    const classRank = (value) => value === "independent" ? 0 : value === "specialist" ? 1 : value === "regional" ? 2 : 3;
    return classRank(a.retailerClass) - classRank(b.retailerClass) || a.name.localeCompare(b.name);
  });
}
