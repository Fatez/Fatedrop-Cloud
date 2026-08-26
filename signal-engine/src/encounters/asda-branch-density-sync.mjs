import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import {
  discoverAsdaBranchUrls,
  parseOfficialBranchPage,
} from "./national-branch-directory-sync.mjs";

const PROVIDER = "asda_official_directory";
const DEFAULT_LIMIT = 600;
const DEFAULT_CONCURRENCY = 8;

async function knownProviderIds(store) {
  if (typeof store?.listRetailerLocations === "function") {
    const rows = await store.listRetailerLocations({ limit: 20000 });
    return new Set((rows || [])
      .filter((row) => String(row.provider || "") === PROVIDER)
      .map((row) => String(row.providerId ?? row.provider_id ?? ""))
      .filter(Boolean));
  }
  if (typeof store?.pool !== "function") return new Set();
  const pool = await store.pool();
  const { rows } = await pool.query(
    "SELECT provider_id FROM fatedrop_retailer_locations WHERE provider=$1",
    [PROVIDER],
  );
  return new Set(rows.map((row) => String(row.provider_id || "")).filter(Boolean));
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function runAsdaBranchDensitySync({
  store,
  fetchImpl = fetch,
  limit = DEFAULT_LIMIT,
  concurrency = DEFAULT_CONCURRENCY,
  discoverFn = discoverAsdaBranchUrls,
  parseFn = parseOfficialBranchPage,
} = {}) {
  if (!store) throw new Error("ASDA branch density sync requires a store");
  const maxLimit = Math.min(1000, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const maxConcurrency = Math.min(12, Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY));

  let discovered;
  try {
    discovered = await discoverFn({ fetchImpl });
  } catch (error) {
    return { provider: PROVIDER, status: "unavailable", discovered: 0, alreadyKnown: 0, attempted: 0, accepted: 0, saved: 0, rejected: 0, error: String(error?.message || error) };
  }

  const unique = new Map();
  for (const row of Array.isArray(discovered) ? discovered : []) {
    const url = canonicalUrl(row?.url);
    if (url) unique.set(url, { ...row, url });
  }
  const known = await knownProviderIds(store).catch(() => new Set());
  const pending = [...unique.values()].filter((row) => !known.has(row.url)).slice(0, maxLimit);
  const accepted = [];
  const rejected = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= pending.length) return;
      const row = pending[index];
      try {
        const parsed = await parseFn(row, { fetchImpl });
        if (!parsed?.location) {
          rejected.push({ url: row.url, reason: parsed?.reason || "branch_parse_failed" });
          continue;
        }
        accepted.push({
          ...parsed.location,
          openingDetails: {
            ...(parsed.location.openingDetails || {}),
            sourceType: "official_retailer_branch_page",
            sourceUrl: row.url,
            sourceAttribution: "ASDA official store locator",
            stockStatus: "unknown",
            stockClaim: false,
          },
        });
      } catch (error) {
        rejected.push({ url: row.url, reason: String(error?.message || error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, Math.max(1, pending.length)) }, () => worker()));
  const normalized = normalizeRetailerLocationBatch(accepted);
  const persisted = normalized.locations.length
    ? await upsertRetailerLocationsIntoStore(store, normalized.locations)
    : { saved: 0 };

  return {
    provider: PROVIDER,
    status: "ok",
    discovered: unique.size,
    alreadyKnown: unique.size - pending.length,
    attempted: pending.length,
    accepted: normalized.locations.length,
    saved: Number(persisted?.saved ?? normalized.locations.length) || 0,
    rejected: rejected.length + normalized.rejected.length,
    rejectionSamples: [...rejected, ...normalized.rejected].slice(0, 20),
    concurrency: maxConcurrency,
    truthRule: "ASDA directory evidence establishes branch identity only; stock remains unknown.",
  };
}
