import {
  normalizeLocalStockObservationBatch,
  upsertLocalStockObservationsIntoStore,
} from "./local-stock-store.mjs";

const ENTERTAINER_POKEMON_PAGE = "https://www.thetoyshop.com/pokemon-at-the-entertainer";

// Human-curated from a current official retailer page. This is preparation evidence only.
// It expires automatically and cannot create Local Manifested.
export const CURATED_INCOMING_INTEL = Object.freeze([
  Object.freeze({
    id: "entertainer-mega-forces-tin-2026-08-28",
    retailerId: "entertainer-uk",
    kind: "echo",
    rawProductTitle: "Pokémon TCG: Mega Forces Tin (Styles Vary)",
    sourceType: "official_retailer_page",
    sourceId: "the-entertainer:pokemon-at-the-entertainer:mega-forces-tin:2026-08-28",
    sourceUrl: ENTERTAINER_POKEMON_PAGE,
    sourceLabel: "The Entertainer official Pokémon TCG page",
    observedAt: "2026-08-26T15:45:00+01:00",
    expectedFrom: "2026-08-28T00:00:00+01:00",
    expectedTo: "2026-08-28T23:59:59+01:00",
    expectedLabel: "Expected 28 August",
    expiresAt: "2026-08-29T23:59:59+01:00",
    confidence: 0.68,
    evidenceBasis: "Official retailer Pokémon TCG page lists this product for 28 August and names participating stores; the retailer also warns that branch stock varies and is not guaranteed.",
    note: "Incoming retailer evidence only. Check the store before travelling.",
    targetBranches: Object.freeze([
      "The Entertainer Basildon",
      "The Entertainer Basingstoke",
      "The Entertainer Birmingham - Bullring",
      "The Entertainer Bishops Stortford",
      "The Entertainer Bluewater - Greenhithe",
      "The Entertainer Bracknell",
      "The Entertainer Bromley Lower Mall",
      "The Entertainer Crawley",
      "The Entertainer Lakeside - Grays",
      "The Entertainer Milton Keynes",
      "The Entertainer Stratford - Westfield",
      "The Entertainer Watford",
      "The Entertainer Westfield London",
    ]),
  }),
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function tokens(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const BRAND_STOPWORDS = new Set(["the", "entertainer", "toys", "toyshop", "store"]);

function targetTerms(target) {
  return tokens(target).filter((token) => !BRAND_STOPWORDS.has(token));
}

function locationHaystack(location = {}) {
  return new Set(tokens([
    location.name,
    location.address,
    location.postcode,
  ].filter(Boolean).join(" ")));
}

export function targetBranchMatchesLocation(target, location = {}) {
  const required = targetTerms(target);
  if (!required.length) return false;
  const haystack = locationHaystack(location);
  return required.every((token) => haystack.has(token));
}

async function listRetailerLocations(store, retailerId) {
  if (typeof store?.listRetailerLocations === "function") {
    const rows = await store.listRetailerLocations({ limit: 20000 });
    return (rows || []).filter((row) => String(row.retailerId ?? row.retailer_id) === retailerId);
  }
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT id,retailer_id,name,address,postcode,provider,provider_id,latitude,longitude
    FROM fatedrop_retailer_locations
    WHERE retailer_id=$1
    ORDER BY updated_at DESC
  `, [retailerId]);
  return rows;
}

function branchId(location = {}) {
  return text(location.id);
}

function branchName(location = {}) {
  return text(location.name) || "Retailer branch";
}

function asObservation(entry, target, location) {
  return {
    kind: entry.kind,
    retailerId: entry.retailerId,
    locationId: branchId(location),
    occurredAt: Date.parse(entry.observedAt),
    evidence: {
      localIntel: true,
      advisory: true,
      scope: "exact_branch_advisory",
      evidenceLevel: "inventory_preparation",
      sourceType: entry.sourceType,
      sourceId: `${entry.sourceId}:${branchId(location)}`,
      sourceUrl: entry.sourceUrl,
      sourceLabel: entry.sourceLabel,
      rawProductTitle: entry.rawProductTitle,
      expectedFrom: entry.expectedFrom,
      expectedTo: entry.expectedTo,
      expectedLabel: entry.expectedLabel,
      confidence: entry.confidence,
      expiresAt: entry.expiresAt,
      evidenceBasis: entry.evidenceBasis,
      note: entry.note,
      targetBranch: target,
      matchedBranchName: branchName(location),
      availabilityVerified: false,
    },
  };
}

async function collectCuratedIncomingIntelMatches({ store, entries, now }) {
  const activeEntries = (Array.isArray(entries) ? entries : []).filter((entry) => {
    const expiresAt = Date.parse(entry.expiresAt || "");
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
  const observations = [];
  const unmatchedTargets = [];
  const matchedLocationIds = new Set();

  for (const entry of activeEntries) {
    const locations = await listRetailerLocations(store, entry.retailerId);
    for (const target of entry.targetBranches || []) {
      const matches = locations.filter((location) => targetBranchMatchesLocation(target, location));
      if (matches.length !== 1) {
        unmatchedTargets.push({
          entryId: entry.id,
          target,
          reason: matches.length ? "ambiguous_branch_match" : "branch_not_found",
          matches: matches.length,
        });
        continue;
      }
      const location = matches[0];
      const id = branchId(location);
      if (!id) {
        unmatchedTargets.push({ entryId: entry.id, target, reason: "branch_identity_missing", matches: 1 });
        continue;
      }
      const key = `${entry.id}|${id}`;
      if (matchedLocationIds.has(key)) continue;
      matchedLocationIds.add(key);
      observations.push(asObservation(entry, target, location));
    }
  }

  return { activeEntries, observations, unmatchedTargets };
}

export async function inspectCuratedIncomingIntelTargets({
  store,
  entries = CURATED_INCOMING_INTEL,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Curated incoming-intel inspection requires a store");
  const matched = await collectCuratedIncomingIntelMatches({ store, entries, now });
  return {
    status: "ok",
    configuredEntries: Array.isArray(entries) ? entries.length : 0,
    activeEntries: matched.activeEntries.length,
    matchedBranches: matched.observations.length,
    unmatchedTargets: matched.unmatchedTargets,
    persisted: false,
    truthRule: "Read-only exact-branch reconciliation only. No Local Radar observation, stock state or history is written.",
  };
}

export async function reconcileCuratedIncomingIntel({
  store,
  entries = CURATED_INCOMING_INTEL,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Curated incoming-intel reconciliation requires a store");
  const matched = await collectCuratedIncomingIntelMatches({ store, entries, now });
  const normalized = normalizeLocalStockObservationBatch(matched.observations);
  const persisted = normalized.observations.length
    ? await upsertLocalStockObservationsIntoStore(store, normalized.observations)
    : { saved: 0, duplicates: 0, rejected: [] };

  return {
    status: "ok",
    configuredEntries: Array.isArray(entries) ? entries.length : 0,
    activeEntries: matched.activeEntries.length,
    matchedBranches: normalized.observations.length,
    saved: Number(persisted.saved || 0),
    duplicates: Number(persisted.duplicates || 0),
    rejected: [...normalized.rejected, ...(persisted.rejected || [])],
    unmatchedTargets: matched.unmatchedTargets,
    truthRule: "Curated incoming intelligence is advisory Whisper/Echo preparation evidence only and can never create Local Manifested without separate exact-branch verified availability evidence.",
  };
}
