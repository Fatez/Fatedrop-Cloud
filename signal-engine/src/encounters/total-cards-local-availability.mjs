import {
  normalizeLocalStockObservationBatch,
  normalizeRetailerLocationBatch,
  upsertLocalStockObservationsIntoStore,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { geocodeUkPostcode } from "./national-branch-directory-sync.mjs";

const TOTAL_CARDS_RETAILER_ID = "total-cards";
const TOTAL_CARDS_GAMING_CENTRE_PAGE = "https://totalcards.net/pages/we-buy-any-cards";
const TOTAL_CARDS_GAMING_CENTRE_POSTCODE = "DL5 6BF";
const TOTAL_CARDS_PROVIDER = "total_cards_official_gaming_centre";

export const TOTAL_CARDS_PHYSICAL_CANDIDATES = Object.freeze([
  Object.freeze({
    id: "total-cards-perfect-order-booster-pack",
    retailerId: TOTAL_CARDS_RETAILER_ID,
    productUrl: "https://totalcards.net/products/pokemon-mega-evolution-perfect-order-booster-pack",
    expectedTitle: "Pokemon - Mega Evolution - Perfect Order - Booster Pack",
  }),
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value = "") {
  return decodeEntities(String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "user-agent": "FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function jsonLdObjects(html) {
  const objects = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html || "").matchAll(re)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) objects.push(...parsed);
      else if (parsed && typeof parsed === "object") {
        objects.push(parsed);
        if (Array.isArray(parsed["@graph"])) objects.push(...parsed["@graph"]);
      }
    } catch {}
  }
  return objects;
}

function collectProductOfferPrices(value, out = []) {
  if (!value || typeof value !== "object") return out;
  const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (type.some((entry) => String(entry || "").toLowerCase() === "product")) {
    const offers = Array.isArray(value.offers) ? value.offers : [value.offers];
    for (const offer of offers.filter(Boolean)) {
      const price = Number(offer?.price ?? offer?.lowPrice);
      if (Number.isFinite(price) && price > 0 && price < 5000) out.push(Math.round(price * 100));
    }
  }
  return out;
}

function structuredProductPricePence(html) {
  const prices = [];
  for (const object of jsonLdObjects(html)) collectProductOfferPrices(object, prices);
  const unique = [...new Set(prices)];
  return unique.length === 1 ? unique[0] : null;
}

export function parseTotalCardsPhysicalAvailability(html = "") {
  const page = stripTags(html);
  const pickupOnly = /\bpickup only\b/i.test(page);
  const availableInStore = /\bavailable to buy in[- ]store\b/i.test(page);
  const explicitlyUnavailableInStore = /\b(?:unavailable|not available) (?:to buy )?in[- ]store\b/i.test(page)
    || /\b(?:store collection|pickup) (?:is )?(?:unavailable|not available)\b/i.test(page);
  return {
    physicalAvailable: pickupOnly && availableInStore,
    explicitPhysicalUnavailable: explicitlyUnavailableInStore,
    pickupOnly,
    availableInStore,
    pricePence: structuredProductPricePence(html),
  };
}

async function existingGamingCentre(store) {
  if (typeof store?.listRetailerLocations === "function") {
    const rows = await store.listRetailerLocations({ limit: 20000 });
    return (rows || []).find((row) => String(row.retailerId ?? row.retailer_id) === TOTAL_CARDS_RETAILER_ID
      && String(row.provider || "") === TOTAL_CARDS_PROVIDER) || null;
  }
  if (typeof store?.pool !== "function") return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT id,retailer_id,provider,provider_id,name,address,postcode,latitude,longitude,website,phone,opening_details_json,verification,updated_at
    FROM fatedrop_retailer_locations
    WHERE retailer_id=$1 AND provider=$2
    ORDER BY updated_at DESC
    LIMIT 1
  `, [TOTAL_CARDS_RETAILER_ID, TOTAL_CARDS_PROVIDER]);
  return rows[0] || null;
}

export async function ensureTotalCardsGamingCentre({ store, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!store) throw new Error("Total Cards branch reconciliation requires a store");
  const existing = await existingGamingCentre(store);
  if (existing) return { status: "existing", location: existing, saved: 0 };

  const html = await fetchText(TOTAL_CARDS_GAMING_CENTRE_PAGE, { fetchImpl });
  const page = stripTags(html);
  if (!/\bTotal Cards Gaming Centre\b/i.test(page) || !/\bDL5\s*6BF\b/i.test(page)) {
    return { status: "unverified", location: null, saved: 0, reason: "official_location_evidence_missing" };
  }
  const geocoded = await geocodeUkPostcode(TOTAL_CARDS_GAMING_CENTRE_POSTCODE, { fetchImpl });
  if (!geocoded) return { status: "unverified", location: null, saved: 0, reason: "coordinates_missing" };

  const normalized = normalizeRetailerLocationBatch([{
    retailerId: TOTAL_CARDS_RETAILER_ID,
    provider: TOTAL_CARDS_PROVIDER,
    providerId: TOTAL_CARDS_GAMING_CENTRE_PAGE,
    name: "Total Cards Gaming Centre",
    address: "Unit 6, Maple Way, Aycliffe Business Park, Newton Aycliffe",
    postcode: TOTAL_CARDS_GAMING_CENTRE_POSTCODE,
    latitude: geocoded.latitude,
    longitude: geocoded.longitude,
    websiteUrl: TOTAL_CARDS_GAMING_CENTRE_PAGE,
    openingDetails: {
      sourceType: "official_retailer_branch_page",
      sourceUrl: TOTAL_CARDS_GAMING_CENTRE_PAGE,
      sourceAttribution: "Total Cards official Gaming Centre information",
      sourceObservedAt: new Date(now).toISOString(),
    },
    verification: "official_retailer_branch",
    updatedAt: now,
  }]);
  if (!normalized.locations.length) {
    return { status: "unverified", location: null, saved: 0, reason: normalized.rejected[0]?.reason || "location_normalization_failed" };
  }
  const result = await upsertRetailerLocationsIntoStore(store, normalized.locations);
  return { status: "saved", location: normalized.locations[0], saved: Number(result?.saved || 0) };
}

export async function resolveTotalCardsCandidate(store, candidate) {
  if (typeof store?.resolveTotalCardsPhysicalCandidate === "function") {
    return store.resolveTotalCardsPhysicalCandidate(candidate);
  }
  if (typeof store?.pool !== "function") return { status: "unavailable", row: null };
  const pool = await store.pool();
  const normalized = normalizeUrl(candidate.productUrl);
  const { rows } = await pool.query(`
    SELECT
      o.offer_id,
      o.product_id,
      o.title AS offer_title,
      o.url AS offer_url,
      p.title AS product_title,
      p.official_rrp_pence,
      p.rrp_source
    FROM fatedrop_retail_offers o
    JOIN fatedrop_product_identities p ON p.id=o.product_id
    WHERE o.retailer_id=$1
      AND split_part(o.url, '?', 1)=$2
    ORDER BY o.last_seen_at DESC
    LIMIT 5
  `, [candidate.retailerId, normalized]);
  const byProduct = new Map();
  for (const row of rows) byProduct.set(row.product_id, row);
  if (byProduct.size !== 1) return { status: byProduct.size ? "ambiguous" : "missing", row: null, matches: byProduct.size };
  return { status: "resolved", row: [...byProduct.values()][0], matches: 1 };
}

async function latestLocalState(store, { locationId, productIdentityId, retailerId }) {
  if (typeof store?.getLatestLocalPhysicalState === "function") {
    return store.getLatestLocalPhysicalState({ locationId, productIdentityId, retailerId });
  }
  if (typeof store?.pool !== "function") return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT kind,occurred_at,evidence_json
    FROM fatedrop_signal_events
    WHERE location_id=$1 AND product_identity_id=$2 AND retailer_id=$3
    ORDER BY occurred_at DESC
    LIMIT 1
  `, [locationId, productIdentityId, retailerId]);
  return rows[0] || null;
}

function locationId(location = {}) {
  return text(location.id);
}

function observationFor({ candidate, resolved, location, availability, kind, now }) {
  const productIdentityId = text(resolved.product_id ?? resolved.productIdentityId);
  const sourceUrl = normalizeUrl(resolved.offer_url ?? resolved.offerUrl ?? candidate.productUrl) || candidate.productUrl;
  const title = text(resolved.offer_title ?? resolved.offerTitle ?? resolved.product_title ?? resolved.productTitle ?? candidate.expectedTitle);
  const rrpPence = Number(resolved.official_rrp_pence ?? resolved.officialRrpPence);
  const itemPricePence = Number(availability.pricePence);
  return {
    kind,
    productIdentityId,
    // Local physical truth is keyed by canonical product + retailer + exact branch + source evidence.
    // fatedrop_signal_events.offer_id still references legacy fatedrop_offers, while this resolver reads
    // fatedrop_retail_offers. Do not attach an incompatible online offer FK to a physical observation.
    offerId: null,
    retailerId: TOTAL_CARDS_RETAILER_ID,
    locationId: locationId(location),
    occurredAt: now,
    evidence: {
      localIntel: true,
      advisory: false,
      scope: "exact_branch",
      evidenceLevel: "official_collection",
      sourceType: "official_retailer_page",
      sourceId: `total-cards:${productIdentityId}:${kind}:gaming-centre`,
      sourceUrl,
      sourceLabel: "Total Cards official product page",
      rawProductTitle: title,
      availabilityVerified: kind === "manifested",
      stockStatus: kind === "manifested" ? "collection_available" : "collection_unavailable",
      physicalCollection: true,
      pickupOnly: availability.pickupOnly === true,
      availableInStore: availability.availableInStore === true,
      ...(Number.isFinite(itemPricePence) && itemPricePence > 0 ? { itemPricePence } : {}),
      ...(Number.isFinite(rrpPence) && rrpPence > 0 ? { rrpPence, rrpSource: text(resolved.rrp_source ?? resolved.rrpSource) } : {}),
      note: kind === "manifested"
        ? "Official Total Cards product page explicitly marks this product Pickup Only and Available to buy in-store. Online stock remains a separate evidence stream."
        : "Official Total Cards product page explicitly reports physical store collection unavailable after prior verified branch availability.",
    },
  };
}

export async function reconcileTotalCardsPhysicalAvailability({
  store,
  fetchImpl = fetch,
  candidates = TOTAL_CARDS_PHYSICAL_CANDIDATES,
  resolveCandidate = resolveTotalCardsCandidate,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Total Cards physical availability reconciliation requires a store");
  let branch;
  try {
    branch = await ensureTotalCardsGamingCentre({ store, fetchImpl, now });
  } catch (error) {
    return { status: "branch_unavailable", branchSaved: 0, checked: 0, saved: 0, duplicates: 0, rejected: [], results: [], error: String(error?.message || error) };
  }
  if (!branch.location) {
    return { status: "branch_unavailable", branchSaved: branch.saved || 0, checked: 0, saved: 0, duplicates: 0, rejected: [], results: [], reason: branch.reason || null };
  }

  const observations = [];
  const results = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const resolvedOutcome = await resolveCandidate(store, candidate);
    if (resolvedOutcome?.status !== "resolved" || !resolvedOutcome.row) {
      results.push({ candidateId: candidate.id, status: resolvedOutcome?.status || "unresolved", saved: false });
      continue;
    }
    const resolved = resolvedOutcome.row;
    const productIdentityId = text(resolved.product_id ?? resolved.productIdentityId);
    if (!productIdentityId) {
      results.push({ candidateId: candidate.id, status: "product_identity_missing", saved: false });
      continue;
    }

    let html;
    try {
      html = await fetchText(candidate.productUrl, { fetchImpl });
    } catch (error) {
      results.push({ candidateId: candidate.id, productIdentityId, status: "source_unavailable", saved: false, error: String(error?.message || error) });
      continue;
    }
    const availability = parseTotalCardsPhysicalAvailability(html);
    const latest = await latestLocalState(store, {
      locationId: locationId(branch.location),
      productIdentityId,
      retailerId: TOTAL_CARDS_RETAILER_ID,
    });
    const latestKind = text(latest?.kind)?.toLowerCase();

    if (availability.physicalAvailable) {
      if (latestKind === "manifested") {
        results.push({ candidateId: candidate.id, productIdentityId, status: "already_manifested", saved: false });
        continue;
      }
      observations.push(observationFor({ candidate, resolved, location: branch.location, availability, kind: "manifested", now }));
      results.push({ candidateId: candidate.id, productIdentityId, status: "manifested_evidence", saved: true });
      continue;
    }

    if (availability.explicitPhysicalUnavailable && latestKind === "manifested") {
      observations.push(observationFor({ candidate, resolved, location: branch.location, availability, kind: "vanished", now }));
      results.push({ candidateId: candidate.id, productIdentityId, status: "vanished_evidence", saved: true });
      continue;
    }

    results.push({
      candidateId: candidate.id,
      productIdentityId,
      status: "physical_state_unknown",
      saved: false,
      pickupOnly: availability.pickupOnly,
      availableInStore: availability.availableInStore,
    });
  }

  const normalized = normalizeLocalStockObservationBatch(observations);
  const persisted = normalized.observations.length
    ? await upsertLocalStockObservationsIntoStore(store, normalized.observations)
    : { saved: 0, duplicates: 0, rejected: [] };

  return {
    status: "ok",
    branchSaved: branch.saved || 0,
    branchId: locationId(branch.location),
    checked: Array.isArray(candidates) ? candidates.length : 0,
    accepted: normalized.observations.length,
    saved: Number(persisted.saved || 0),
    duplicates: Number(persisted.duplicates || 0),
    rejected: [...normalized.rejected, ...(persisted.rejected || [])],
    results,
    truthRule: "Total Cards online stock and Newton Aycliffe physical collection are separate evidence streams. Local Manifested requires explicit official in-store collection availability for an exact canonical product and exact canonical branch.",
  };
}