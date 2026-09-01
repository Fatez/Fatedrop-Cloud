import { deriveAlertFacets } from "../core/alert-facets.mjs";
import { publicSignalSqlFilter, validVanishedSqlFilter } from "../core/signal-visibility-policy.mjs";

const DEFAULT_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ROW_LIMIT = 1_000;
const DEFAULT_SAMPLE_LIMIT = 40;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function unavailable(reason = "facet_coverage_unavailable") {
  return {
    available: false,
    reason,
    sampleSize: 0,
    actionableRows: 0,
    unresolvedLanguage: 0,
    ambiguousLanguage: 0,
    unresolvedSet: 0,
    languageConflicts: 0,
    uniqueActionableTitles: 0,
    sampleTruncated: false,
    samples: [],
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolutionFor(facets) {
  const language = facets?.resolution?.language
    || (facets?.source?.language?.startsWith?.("language_conflict:") ? "conflict"
      : facets?.languageGroup === "unknown" ? "unresolved" : "resolved");
  const set = facets?.resolution?.set
    || (facets?.setKey === "not-set-specific" ? "not_applicable"
      : facets?.setKey ? "resolved" : "unresolved");
  return { language, set };
}

export function buildAlertFacetCoverage(rows = [], { sampleLimit = DEFAULT_SAMPLE_LIMIT } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const safeSampleLimit = boundedInteger(sampleLimit, DEFAULT_SAMPLE_LIMIT, 1, 100);
  const grouped = new Map();
  let unresolvedLanguage = 0;
  let ambiguousLanguage = 0;
  let unresolvedSet = 0;
  let languageConflicts = 0;
  let actionableRows = 0;

  for (const row of input) {
    const title = text(row?.title);
    if (!title) continue;
    const facets = deriveAlertFacets({ title, evidence: row?.evidence || [] });
    const resolution = resolutionFor(facets);
    const missingLanguage = resolution.language === "unresolved";
    const ambiguous = resolution.language === "ambiguous_multilingual";
    const conflict = resolution.language === "conflict";
    const missingSet = resolution.set === "unresolved";

    if (missingLanguage) unresolvedLanguage += 1;
    if (ambiguous) ambiguousLanguage += 1;
    if (conflict) languageConflicts += 1;
    if (missingSet) unresolvedSet += 1;

    if (!missingLanguage && !conflict && !missingSet) continue;
    actionableRows += 1;

    const retailerId = text(row?.retailer_id);
    const key = `${title.toLowerCase()}\u0000${retailerId}`;
    const detectedAt = Number(row?.detected_at);
    const existing = grouped.get(key);
    const sample = existing || {
      title,
      retailerId: retailerId || null,
      retailerName: text(row?.retailer_name) || null,
      state: text(row?.state) || null,
      latestDetectedAt: Number.isFinite(detectedAt) ? detectedAt : null,
      occurrences: 0,
      unresolvedLanguage: false,
      unresolvedSet: false,
      languageConflict: false,
      languageSource: facets?.source?.language || "unknown",
      setSource: facets?.source?.set || "unknown",
    };
    sample.occurrences += 1;
    sample.unresolvedLanguage ||= missingLanguage;
    sample.unresolvedSet ||= missingSet;
    sample.languageConflict ||= conflict;
    if (Number.isFinite(detectedAt) && (sample.latestDetectedAt == null || detectedAt > sample.latestDetectedAt)) {
      sample.latestDetectedAt = detectedAt;
      sample.state = text(row?.state) || sample.state;
      sample.retailerName = text(row?.retailer_name) || sample.retailerName;
      sample.languageSource = facets?.source?.language || sample.languageSource;
      sample.setSource = facets?.source?.set || sample.setSource;
    }
    grouped.set(key, sample);
  }

  const ranked = [...grouped.values()].sort((left, right) => (
    right.occurrences - left.occurrences
    || Number(right.latestDetectedAt || 0) - Number(left.latestDetectedAt || 0)
    || left.title.localeCompare(right.title)
  ));

  return {
    available: true,
    reason: null,
    sampleSize: input.length,
    actionableRows,
    unresolvedLanguage,
    ambiguousLanguage,
    unresolvedSet,
    languageConflicts,
    uniqueActionableTitles: ranked.length,
    sampleTruncated: ranked.length > safeSampleLimit,
    samples: ranked.slice(0, safeSampleLimit),
  };
}

export async function loadAlertFacetCoverage(pool, {
  now = Math.floor(Date.now() / 1000),
  lookbackSeconds = DEFAULT_LOOKBACK_SECONDS,
  rowLimit = DEFAULT_ROW_LIMIT,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
} = {}) {
  if (!pool || typeof pool.query !== "function") return unavailable("persistent_store_unavailable");
  const safeLookback = boundedInteger(lookbackSeconds, DEFAULT_LOOKBACK_SECONDS, 60 * 60, 90 * 24 * 60 * 60);
  const safeRowLimit = boundedInteger(rowLimit, DEFAULT_ROW_LIMIT, 50, 5_000);
  const since = Math.max(0, Math.trunc(Number(now) || 0) - safeLookback);

  try {
    const result = await pool.query(`
      SELECT s.id,s.state,s.retailer_id,s.retailer_name,s.title,s.detected_at,s.evidence
      FROM fatedrop_signals s
      WHERE s.detected_at >= $1
        AND s.state IN ('whisper','echo','manifested','vanished')
        AND ${publicSignalSqlFilter("s")}
        AND ${validVanishedSqlFilter("s")}
      ORDER BY s.detected_at DESC
      LIMIT $2
    `, [since, safeRowLimit]);
    return buildAlertFacetCoverage(result.rows, { sampleLimit });
  } catch {
    return unavailable("facet_coverage_query_failed");
  }
}
