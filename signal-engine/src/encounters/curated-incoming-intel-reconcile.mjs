import {
  normalizeLocalStockObservationBatch,
  upsertLocalStockObservationsIntoStore,
} from "./local-stock-store.mjs";

const ENTERTAINER_POKEMON_PAGE = "https://www.thetoyshop.com/pokemon-at-the-entertainer";
const RETAILER_CHAIN_ECHO_SOURCES = new Set([
  "retailer_staff_report",
  "official_store_social",
  "retailer_submission",
  "authorised_feed",
]);
const LONDON_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const LONDON_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

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

function dateTimeParts(formatter, timestamp, wanted) {
  return Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => wanted.includes(part.type))
      .map((part) => [part.type, Number(part.value)]),
  );
}

function londonOffsetMs(timestamp) {
  const wholeSecond = Math.trunc(timestamp / 1000) * 1000;
  const parts = dateTimeParts(
    LONDON_CLOCK,
    wholeSecond,
    ["year", "month", "day", "hour", "minute", "second"],
  );
  const londonWallTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return londonWallTimeAsUtc - wholeSecond;
}

function nextLondonCalendarDayStart(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  const parts = dateTimeParts(LONDON_DATE, timestamp, ["year", "month", "day"]);
  const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const londonMidnightAsUtc = Date.UTC(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth(),
    nextDate.getUTCDate(),
  );
  const firstGuess = londonMidnightAsUtc - londonOffsetMs(londonMidnightAsUtc);
  return londonMidnightAsUtc - londonOffsetMs(firstGuess);
}

export function expectedIntelClearAt(entry = {}) {
  const physicalDateBoundary = nextLondonCalendarDayStart(entry.expectedTo || entry.expectedFrom);
  if (Number.isFinite(physicalDateBoundary)) return new Date(physicalDateBoundary).toISOString();
  const fallback = Date.parse(entry.expiresAt || "");
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : null;
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

function asBranchObservation(entry, target, location) {
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

function canPersistRetailerChainEcho(entry) {
  return entry?.kind === "echo" && RETAILER_CHAIN_ECHO_SOURCES.has(String(entry?.sourceType || "").toLowerCase());
}

function asRetailerChainObservation(entry) {
  return {
    kind: "echo",
    retailerId: entry.retailerId,
    locationId: null,
    occurredAt: Date.parse(entry.observedAt),
    evidence: {
      localIntel: true,
      advisory: true,
      scope: "retailer_chain",
      evidenceLevel: "inventory_preparation",
      sourceType: entry.sourceType,
      sourceId: `${entry.sourceId}:retailer-chain`,
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
      availabilityVerified: false,
      branchVerified: false,
    },
  };
}

export async function reconcileCuratedIncomingIntel({
  store,
  entries = CURATED_INCOMING_INTEL,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Curated incoming-intel reconciliation requires a store");
  const preparedEntries = (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    expiresAt: expectedIntelClearAt(entry),
  }));
  const activeEntries = preparedEntries.filter((entry) => {
    const expiresAt = Date.parse(entry.expiresAt || "");
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
  const observations = [];
  const unmatchedTargets = [];
  const matchedLocationIds = new Set();

  for (const entry of activeEntries) {
    if (canPersistRetailerChainEcho(entry)) {
      observations.push(asRetailerChainObservation(entry));
    }

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
      observations.push(asBranchObservation(entry, target, location));
    }
  }

  const normalized = normalizeLocalStockObservationBatch(observations);
  const persisted = normalized.observations.length
    ? await upsertLocalStockObservationsIntoStore(store, normalized.observations)
    : { saved: 0, duplicates: 0, rejected: [] };
  const matchedBranches = normalized.observations.filter((observation) => Boolean(observation.locationId)).length;
  const retailerChainRecords = normalized.observations.filter((observation) => !observation.locationId && observation.evidence?.scope === "retailer_chain").length;

  return {
    status: "ok",
    configuredEntries: Array.isArray(entries) ? entries.length : 0,
    activeEntries: activeEntries.length,
    matchedBranches,
    retailerChainRecords,
    saved: Number(persisted.saved || 0),
    duplicates: Number(persisted.duplicates || 0),
    rejected: [...normalized.rejected, ...(persisted.rejected || [])],
    unmatchedTargets,
    truthRule: "Curated incoming intelligence is advisory Whisper/Echo preparation evidence only. Strong retailer-chain Echo intelligence may persist without a resolved branch and stays active through the expected physical-stock date, then clears at the start of the following Europe/London calendar day. It can never create Local Manifested without separate exact-branch verified availability evidence.",
  };
}
