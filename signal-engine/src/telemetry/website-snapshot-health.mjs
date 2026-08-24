const DEFAULT_STALE_AFTER_SECONDS = 15 * 60;

let state = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastReason: null,
  lastError: null,
  lastHttpStatus: null,
};

function epoch(value = Date.now()) {
  return Math.floor(Number(value) / (Number(value) > 10_000_000_000 ? 1000 : 1));
}

export function websiteSnapshotConfiguration() {
  const urlConfigured = Boolean(String(process.env.FATEDROP_WEBSITE_SNAPSHOT_URL || "").trim());
  const secretConfigured = Boolean(String(process.env.FATEDROP_METRICS_INGEST_SECRET || "").trim());
  return {
    configured: urlConfigured && secretConfigured,
    urlConfigured,
    secretConfigured,
  };
}

export function websiteSnapshotConfigured() {
  return websiteSnapshotConfiguration().configured;
}

export function recordWebsiteSnapshotOutcome(result = {}, { attemptedAt = Math.floor(Date.now() / 1000) } = {}) {
  const at = epoch(attemptedAt);
  const published = result?.published === true;
  state = {
    ...state,
    lastAttemptAt: at,
    lastSuccessAt: published ? at : state.lastSuccessAt,
    lastFailureAt: published ? state.lastFailureAt : at,
    lastReason: String(result?.reason || (published ? "published" : "unknown")),
    lastError: published || !result?.error ? null : String(result.error).slice(0, 300),
    lastHttpStatus: Number.isFinite(Number(result?.httpStatus)) ? Number(result.httpStatus) : null,
  };
  return getWebsiteSnapshotHealth({ now: at });
}

export function getWebsiteSnapshotHealth({
  now = Math.floor(Date.now() / 1000),
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
} = {}) {
  const checkedAt = epoch(now);
  const staleAfter = Math.max(60, Number(staleAfterSeconds) || DEFAULT_STALE_AFTER_SECONDS);
  const configuration = websiteSnapshotConfiguration();
  const ageSeconds = state.lastSuccessAt == null ? null : Math.max(0, checkedAt - state.lastSuccessAt);

  let ready = false;
  let reason = "not_checked";
  if (!configuration.configured) reason = "not_configured";
  else if (state.lastSuccessAt == null) reason = state.lastReason || "not_published_yet";
  else if (ageSeconds > staleAfter) reason = "stale";
  else {
    ready = true;
    reason = null;
  }

  return {
    checkedAt,
    ready,
    reason,
    staleAfterSeconds: staleAfter,
    lastSuccessAgeSeconds: ageSeconds,
    ...configuration,
    ...state,
  };
}

export function resetWebsiteSnapshotHealthForTests() {
  state = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastReason: null,
    lastError: null,
    lastHttpStatus: null,
  };
}
