import { RETAILER_STATES, VERIFICATION_STATES, normalizeRetailerCandidate } from "./registry.mjs";

function key(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Seed discovery candidates without ever mutating an existing retailer.
 *
 * This is intentionally insert-only. A retailer that has already progressed to
 * qualifying/ready/monitored (or has been paused/rejected) is canonical registry
 * truth and must never be downgraded by a source-code seed on application start.
 */
export async function ensureDiscoveryCandidatesInRegistry({ registry, candidates = [] } = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.upsert !== "function") {
    throw new TypeError("Canonical retailer registry is required");
  }

  const existing = await registry.list({ limit: 5000 });
  const knownIds = new Set((existing || []).map((retailer) => key(retailer?.id)).filter(Boolean));
  const knownHostnames = new Set((existing || []).map((retailer) => key(retailer?.hostname)).filter(Boolean));
  const inserted = [];
  const skippedExisting = [];

  for (const input of candidates || []) {
    const candidate = normalizeRetailerCandidate(input);
    const id = key(candidate.id);
    const hostname = key(candidate.hostname);

    if (!id || !hostname) throw new Error("Discovery candidate requires id and hostname");
    if (candidate.state !== RETAILER_STATES.CANDIDATE) {
      throw new Error(`Discovery auto-seed refuses non-candidate lifecycle state for ${candidate.id}`);
    }
    if (candidate.verification !== VERIFICATION_STATES.UNVERIFIED) {
      throw new Error(`Discovery auto-seed refuses verified retailer ${candidate.id}`);
    }
    if (candidate.catalogue?.feedApproved === true) {
      throw new Error(`Discovery auto-seed refuses approved feed for ${candidate.id}`);
    }

    if (knownIds.has(id) || knownHostnames.has(hostname)) {
      skippedExisting.push(candidate.id);
      continue;
    }

    const saved = await registry.upsert(candidate);
    knownIds.add(id);
    knownHostnames.add(hostname);
    inserted.push(saved.id);
  }

  return {
    inserted,
    insertedCount: inserted.length,
    skippedExisting,
    skippedExistingCount: skippedExisting.length,
    existingCount: (existing || []).length,
  };
}
