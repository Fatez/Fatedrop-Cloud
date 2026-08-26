import crypto from "node:crypto";
import {
  enrichShopsWithLocalStock,
  listLocalStockObservationsFromStore,
  localStockCounts,
} from "./local-stock-intelligence.mjs";
import { persistMatchedRetailerLocations } from "./local-radar-branch-persistence.mjs";
import { refreshSmythsLocalAvailability } from "./smyths-local-availability.mjs";

const TCG_LABELS = Object.freeze({
  pokemon: "Pokemon",
  mtg: "Magic the Gathering",
  "magic-the-gathering": "Magic the Gathering",
  yugioh: "Yu-Gi-Oh",
  "yu-gi-oh": "Yu-Gi-Oh",
  "one-piece": "One Piece Card Game",
  lorcana: "Disney Lorcana",
});

const EVENT_SOURCE_TYPES = new Set([
  "organiser_submission",
  "retailer_submission",
  "manual_research",
  "authorised_feed",
  "official_tcg",
]);

const EVENT_VERIFICATION_STATES = new Set([
  "submitted",
  "source_verified",
  "fatedrop_verified",
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function array(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function isoDate(value, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new Error("Encounter requires startDateTime");
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Encounter has an invalid date");
  return date.toISOString();
}

function slug(value = "") {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

export function canonicalEncounterKey(record = {}) {
  const name = slug(record.name);
  const start = isoDate(record.startDateTime || record.startAt, { required: true }).slice(0, 10);
  const place = postcodeKey(record.postcode) || slug(record.venueName || record.townCity || record.address || "unknown");
  if (!name) throw new Error("Encounter requires name");
  return `${name}|${start}|${place}`;
}

export function normalizeEncounter(record = {}) {
  const canonicalKey = canonicalEncounterKey(record);
  const id = text(record.id) || `enc_${crypto.createHash("sha256").update(canonicalKey).digest("hex").slice(0, 20)}`;
  const sourceType = EVENT_SOURCE_TYPES.has(record.sourceType) ? record.sourceType : "manual_research";
  const verificationStatus = EVENT_VERIFICATION_STATES.has(record.verificationStatus)
    ? record.verificationStatus
    : "submitted";
  const startDateTime = isoDate(record.startDateTime || record.startAt, { required: true });
  const endDateTime = isoDate(record.endDateTime || record.endAt);
  const latitude = number(record.latitude);
  const longitude = number(record.longitude);
  if ((latitude == null) !== (longitude == null)) throw new Error("Encounter coordinates require both latitude and longitude");
  if (latitude != null && (latitude < -90 || latitude > 90)) throw new Error("Encounter latitude is out of range");
  if (longitude != null && (longitude < -180 || longitude > 180)) throw new Error("Encounter longitude is out of range");
  return {
    id,
    canonicalKey,
    itemType: "event",
    name: text(record.name),
    description: text(record.description),
    startDateTime,
    endDateTime,
    venueName: text(record.venueName),
    address: text(record.address),
    townCity: text(record.townCity),
    postcode: text(record.postcode)?.toUpperCase() || null,
    region: text(record.region),
    latitude,
    longitude,
    ticketPriceText: text(record.ticketPriceText),
    categories: array(record.categories),
    supportedTcgs: array(record.supportedTcgs).map((value) => value.toLowerCase()),
    imageUrl: httpUrl(record.imageUrl),
    organiserName: text(record.organiserName),
    officialEventUrl: httpUrl(record.officialEventUrl),
    officialTicketUrl: httpUrl(record.officialTicketUrl),
    vendorInformationUrl: httpUrl(record.vendorInformationUrl),
    vendorApplicationsStatus: ["open", "closed", "unknown"].includes(record.vendorApplicationsStatus)
      ? record.vendorApplicationsStatus
      : "unknown",
    featured: record.featured === true,
    verificationStatus,
    sourceType,
    sourceUrl: httpUrl(record.sourceUrl),
    lastVerifiedAt: isoDate(record.lastVerifiedAt),
  };
}

export function normalizeEncounterBatch(records = []) {
  if (!Array.isArray(records)) throw new Error("Encounter batch must be an array");
  const accepted = [];
  const rejected = [];
  const byKey = new Map();
  records.forEach((record, index) => {
    try {
      const event = normalizeEncounter(record);
      const existing = byKey.get(event.canonicalKey);
      if (!existing) {
        byKey.set(event.canonicalKey, event);
        accepted.push(event);
        return;
      }
      const merged = {
        ...existing,
        ...Object.fromEntries(Object.entries(event).filter(([, value]) => value != null && value !== "")),
        categories: [...new Set([...existing.categories, ...event.categories])],
        supportedTcgs: [...new Set([...existing.supportedTcgs, ...event.supportedTcgs])],
      };
      byKey.set(event.canonicalKey, merged);
      const position = accepted.findIndex((item) => item.canonicalKey === event.canonicalKey);
      accepted[position] = merged;
    } catch (error) {
      rejected.push({ index, name: text(record?.name), reason: String(error?.message || error) });
    }
  });
  return { events: accepted, rejected, received: records.length, accepted: records.length - rejected.length, unique: accepted.length };
}

export function distanceMiles(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
}

function retailerNameMatches(placeName, retailer) {
  const place = slug(placeName);
  const canonical = slug(retailer?.name || "");
  if (!place || !canonical) return false;
  if (place === canonical) return true;
  const aliases = Array.isArray(retailer?.localRadarAliases) ? retailer.localRadarAliases.map(slug) : [];
  if (aliases.includes(place)) return true;
  const nationalAliases = {
    "smyths-uk": ["smyths toys", "smyths toys superstores", "smyths"],
    "entertainer-uk": ["the entertainer", "entertainer"],
    "tesco-uk": ["tesco", "tesco extra", "tesco superstore"],
    "argos-uk": ["argos", "argos in sainsburys", "argos inside sainsburys"],
  };
  const known = nationalAliases[retailer?.id] || [];
  return known.some((alias) => place === alias || place.startsWith(`${alias} `));
}

function exactRetailerMatch(place, retailers = []) {
  const placeHost = hostname(place.websiteUrl);
  const matches = retailers.filter((retailer) => {
    const retailerHost = hostname(retailer.baseUrl);
    return (placeHost && retailerHost && placeHost === retailerHost) || retailerNameMatches(place.name, retailer);
  });
  return matches.length === 1 ? matches[0] : null;
}

function placeToShop(place = {}) {
  return {
    id: `google:${place.id}`,
    itemType: "shop",
    provider: "google_places",
    providerPlaceId: place.id,
    name: text(place.displayName?.text) || "Trading card shop",
    address: text(place.formattedAddress),
    latitude: number(place.location?.latitude),
    longitude: number(place.location?.longitude),
    websiteUrl: httpUrl(place.websiteUri),
    businessStatus: text(place.businessStatus)?.toLowerCase() || "unknown",
    verificationStatus: "discovered",
    discoveryScope: "candidate-only",
    networkStatus: "local_indie",
    retailerId: null,
    localStockStatus: "unknown",
    stockEvidence: "none",
    onlineCatalogue: null,
    sourceAttribution: "Google Places",
  };
}

export async function searchGoogleTcgShops({
  apiKey,
  latitude,
  longitude,
  radiusMiles = 25,
  postcode = null,
  tcg = null,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) return { status: "unconfigured", shops: [], provider: "google_places" };
  const lat = number(latitude);
  const lng = number(longitude);
  const radius = Math.max(1, Math.min(31, number(radiusMiles) || 25));
  const label = TCG_LABELS[String(tcg || "").toLowerCase()] || null;
  const queries = [...new Set([
    label ? `${label} trading card shop` : "trading card shop",
    label ? `${label} TCG shop` : "TCG shop",
    "collectible card game store",
  ])];
  const found = new Map();
  for (const query of queries) {
    const body = {
      textQuery: postcode ? `${query} near ${postcode}` : query,
      pageSize: 20,
      languageCode: "en",
      regionCode: "gb",
      rankPreference: lat != null && lng != null ? "DISTANCE" : "RELEVANCE",
    };
    if (lat != null && lng != null) {
      body.locationBias = {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: Math.min(50000, radius * 1609.344),
        },
      };
    }
    const response = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.businessStatus,places.primaryType,places.types",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Google Places search failed (${response.status})`);
    const data = await response.json();
    for (const place of data.places || []) {
      if (!place?.id || found.has(place.id)) continue;
      found.set(place.id, placeToShop(place));
    }
  }
  return { status: "ok", shops: [...found.values()], provider: "google_places" };
}

function includesTcg(event, tcg) {
  if (!tcg) return true;
  const needle = String(tcg).toLowerCase();
  return (event.supportedTcgs || []).some((value) => value === needle || value === "all" || value === "all tcg");
}

export async function buildLocalRadar({
  store,
  retailers = [],
  placesApiKey = "",
  placesSearch = searchGoogleTcgShops,
  smythsAvailabilityRefresh = refreshSmythsLocalAvailability,
  latitude = null,
  longitude = null,
  postcode = null,
  radiusMiles = 25,
  tcg = null,
  types = ["shops", "events"],
  from = new Date().toISOString(),
  to = null,
} = {}) {
  const requested = new Set(types);
  const origin = Number.isFinite(number(latitude)) && Number.isFinite(number(longitude))
    ? { latitude: number(latitude), longitude: number(longitude) }
    : null;
  const safeRadius = Math.max(1, Math.min(100, number(radiusMiles) || 25));
  let shopResult = { status: "skipped", shops: [], provider: "google_places" };
  if (requested.has("shops")) {
    try {
      shopResult = await placesSearch({
        apiKey: placesApiKey,
        latitude: origin?.latitude,
        longitude: origin?.longitude,
        postcode,
        radiusMiles: safeRadius,
        tcg,
      });
    } catch (error) {
      shopResult = { status: "unavailable", shops: [], provider: "google_places", error: String(error?.message || error) };
    }
  }

  const offers = requested.has("shops") && typeof store?.listOffers === "function"
    ? await store.listOffers({ limit: 10000 })
    : [];
  const availableByRetailer = new Map();
  for (const offer of offers) {
    if (!["in_stock", "low_stock", "preorder"].includes(offer.stockStatus)) continue;
    availableByRetailer.set(offer.retailerId, (availableByRetailer.get(offer.retailerId) || 0) + 1);
  }

  const discoveredShops = shopResult.shops.map((shop) => {
    const retailer = exactRetailerMatch(shop, retailers);
    const distance = origin && shop.latitude != null && shop.longitude != null
      ? distanceMiles(origin, shop)
      : null;
    return {
      ...shop,
      distanceMiles: distance,
      networkStatus: retailer ? "live_connected" : "local_indie",
      retailerId: retailer?.id || null,
      stockEvidence: retailer ? "online_catalogue_only" : "none",
      onlineCatalogue: retailer
        ? { availableOffers: availableByRetailer.get(retailer.id) || 0, scope: "online-catalogue-not-branch-stock" }
        : null,
    };
  });

  const branchIdentityResult = requested.has("shops")
    ? await persistMatchedRetailerLocations(store, discoveredShops)
    : { status: "skipped", saved: 0, rejected: [], received: 0 };

  let smythsSourceResult = {
    provider: "smyths_official_store_availability",
    status: "skipped",
    productsChecked: 0,
    observationsSaved: 0,
    rejected: 0,
  };
  if (requested.has("shops") && origin && typeof smythsAvailabilityRefresh === "function") {
    try {
      smythsSourceResult = await smythsAvailabilityRefresh({
        store,
        shops: discoveredShops,
        latitude: origin.latitude,
        longitude: origin.longitude,
      });
    } catch (error) {
      smythsSourceResult = {
        provider: "smyths_official_store_availability",
        status: "unavailable",
        productsChecked: 0,
        observationsSaved: 0,
        rejected: 0,
        error: String(error?.message || error),
      };
    }
  }

  let localStockObservations = [];
  let localStockProviderStatus = "unconfigured";
  if (requested.has("shops")) {
    try {
      localStockObservations = await listLocalStockObservationsFromStore(store);
      localStockProviderStatus = localStockObservations.length ? "ok" : "empty";
    } catch {
      localStockObservations = [];
      localStockProviderStatus = "unavailable";
    }
  }

  const shops = enrichShopsWithLocalStock(discoveredShops, localStockObservations)
    .filter((shop) => shop.distanceMiles == null || shop.distanceMiles <= safeRadius);
  const stockCounts = localStockCounts(shops);

  const rawEvents = requested.has("events") && typeof store?.listEncounters === "function"
    ? await store.listEncounters({ from, to, tcgs: tcg ? [tcg] : [], limit: 1000 })
    : [];
  const events = rawEvents.filter((event) => includesTcg(event, tcg)).map((event) => {
    const distance = origin && event.latitude != null && event.longitude != null
      ? distanceMiles(origin, event)
      : null;
    return { ...event, itemType: "event", distanceMiles: distance };
  }).filter((event) => event.distanceMiles == null || event.distanceMiles <= safeRadius);

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    query: {
      latitude: origin?.latitude ?? null,
      longitude: origin?.longitude ?? null,
      postcode: postcode || null,
      radiusMiles: safeRadius,
      tcg: tcg || null,
      types: [...requested],
      from,
      to: to || null,
    },
    providers: {
      shops: { provider: shopResult.provider, status: shopResult.status },
      branchIdentity: {
        provider: "fatedrop_retailer_locations",
        status: branchIdentityResult.status,
        saved: branchIdentityResult.saved,
        rejected: branchIdentityResult.rejected.length,
      },
      smythsLocalStock: smythsSourceResult,
      localStock: { provider: "fatedrop_signal_events", status: requested.has("shops") ? localStockProviderStatus : "skipped" },
      events: { provider: "fatedrop_encounters", status: typeof store?.listEncounters === "function" ? "ok" : "unconfigured" },
    },
    shops,
    events,
    counts: {
      shops: shops.length,
      events: events.length,
      localInStockBranches: stockCounts.inStock,
      localLowStockBranches: stockCounts.lowStock,
      incomingWatchBranches: stockCounts.incomingWatch,
    },
    disclaimers: [
      "Discovered shops are location candidates, not FateDrop verification or stock evidence.",
      "Matched connected retailer branches may be persisted as stable location identities; this does not verify branch stock.",
      "Live Connected means FateDrop has a connected online catalogue. It does not prove stock at a specific physical branch.",
      "Verified local stock is only shown when branch-level official evidence is present and still fresh.",
      "Smyths branch stock uses the retailer's ordinary public collection availability route only; protected or rate-limited responses fail closed and are not bypassed.",
      "Community or social evidence can create an Incoming Watch but can never be promoted to verified branch stock on its own.",
      "Event details can change; check the organiser or ticket source before travelling.",
    ],
  };
}
