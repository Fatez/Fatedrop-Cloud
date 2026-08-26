import { publicPresenceForRetailer } from "./presence.mjs";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function publicWebsite(retailer) {
  return publicUrl(retailer?.websiteUrl) || publicUrl(retailer?.baseUrl);
}

function verificationState(retailer) {
  if (typeof retailer?.verification === "string") return retailer.verification;
  return text(retailer?.verification?.status) || "unverified";
}

function tcgsFor(retailer) {
  const raw = Array.isArray(retailer?.tcgs) && retailer.tcgs.length ? retailer.tcgs : [retailer?.tcg || "pokemon"];
  return [...new Set(raw.map((value) => text(String(value)).toLowerCase()).filter(Boolean))];
}

function publicMonitoring(health) {
  return {
    configured: true,
    healthy: health?.healthy === true,
    stale: health?.stale === true,
    baselineCompleted: health?.baselineCompleted === true,
    productsSeen: Number.isFinite(health?.productsSeen) ? health.productsSeen : null,
    lastScanAt: Number.isFinite(health?.lastScanAt) ? health.lastScanAt : null,
    lastSuccessAt: Number.isFinite(health?.lastSuccessAt) ? health.lastSuccessAt : null,
  };
}

function directoryEntry(retailer, health) {
  const presence = publicPresenceForRetailer(retailer);
  return {
    id: retailer.id,
    name: retailer.name,
    websiteUrl: publicWebsite(retailer),
    logoUrl: publicUrl(retailer?.logoUrl),
    description: text(retailer?.publicDescription) || null,
    retailerClass: retailer.retailerClass || "independent",
    verification: verificationState(retailer),
    tcgs: tcgsFor(retailer),
    online: presence.online,
    physicalStores: presence.physicalStores,
    physicalLocations: presence.physicalLocations,
    monitoring: publicMonitoring(health),
  };
}

export function buildPublicRetailerDirectory({ retailers = [], healthRows = [] } = {}) {
  const healthById = new Map((healthRows || []).map((health) => [health.id, health]));
  return (retailers || [])
    .map((retailer) => directoryEntry(retailer, healthById.get(retailer.id) || null))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function publicLocation(location = {}) {
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!location.id || !location.retailerId || !location.name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id: String(location.id),
    retailerId: String(location.retailerId),
    name: String(location.name),
    address: text(location.address) || null,
    postcode: text(location.postcode)?.toUpperCase() || null,
    latitude,
    longitude,
    websiteUrl: publicUrl(location.website),
    phone: text(location.phone) || null,
    verification: text(location.verification) || "source_verified",
  };
}

export function buildPublicRetailerProfile({ retailer, health = null, locations = [] } = {}) {
  if (!retailer?.id || !retailer?.name) return null;
  const publicLocations = (Array.isArray(locations) ? locations : [])
    .filter((location) => String(location?.retailerId || "") === String(retailer.id))
    .map(publicLocation)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const entry = directoryEntry(retailer, health);
  return {
    ...entry,
    physicalStores: publicLocations.length > 0 ? true : entry.physicalStores,
    physicalLocations: publicLocations.length > 0 ? publicLocations.length : entry.physicalLocations,
    locations: publicLocations,
  };
}