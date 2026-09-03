import { assertFatePriceProviderApproved } from './provider-policy.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Join persisted market observations to their ingest-run acquisition provenance.
 *
 * Market observations intentionally store sourceName/sourceSnapshotId while the
 * acquisition permission key is stored on the ingest run. This helper produces
 * the enriched evidence expected by resolveFatePrice without weakening that
 * separation.
 */
export function enrichMarketObservationsWithProviderPolicy({
  observations,
  ingestRuns,
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  if (!Array.isArray(ingestRuns)) throw new TypeError('ingestRuns must be an array');

  const runsById = new Map();
  for (const run of ingestRuns) {
    const id = text(run?.id);
    if (id) runsById.set(id, run);
  }

  const enriched = [];
  const rejected = [];

  for (const observation of observations) {
    const ingestRunId = text(observation?.ingestRunId);
    const run = runsById.get(ingestRunId);
    if (!run) {
      rejected.push(Object.freeze({ observation, reason: 'ingest_run_unavailable' }));
      continue;
    }

    if (text(run.sourceName) !== text(observation.sourceName)
      || text(run.sourceSnapshotId) !== text(observation.sourceSnapshotId)) {
      rejected.push(Object.freeze({ observation, reason: 'ingest_run_source_mismatch' }));
      continue;
    }

    const providerPolicyKey = text(run.metadataJson?.providerPolicyKey);
    if (!providerPolicyKey) {
      rejected.push(Object.freeze({ observation, reason: 'provider_policy_missing' }));
      continue;
    }

    let policy;
    try {
      policy = assertFatePriceProviderApproved(providerPolicyKey);
    } catch (error) {
      rejected.push(Object.freeze({
        observation,
        providerPolicyKey,
        reason: error?.code || 'provider_policy_not_approved',
      }));
      continue;
    }

    if (policy.sourceName !== text(observation.sourceName)) {
      rejected.push(Object.freeze({ observation, providerPolicyKey, reason: 'provider_policy_source_mismatch' }));
      continue;
    }

    enriched.push(Object.freeze({
      ...observation,
      providerPolicyKey: policy.key,
      acquisitionMode: policy.acquisitionMode,
    }));
  }

  return Object.freeze({
    observations: Object.freeze(enriched),
    rejected: Object.freeze(rejected),
  });
}
