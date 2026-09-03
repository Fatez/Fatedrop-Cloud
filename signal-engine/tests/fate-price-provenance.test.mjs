import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichMarketObservationsWithProviderPolicy } from '../src/trader/value/price-provenance.mjs';

function observation(overrides = {}) {
  return {
    id: 'obs-1',
    ingestRunId: 'run-1',
    sourceName: 'cardmarket',
    sourceSnapshotId: 'snapshot-1',
    cardIdentityId: 'card-1',
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 'run-1',
    sourceName: 'cardmarket',
    sourceSnapshotId: 'snapshot-1',
    metadataJson: {
      providerPolicyKey: 'cardmarket-public-download',
      acquisitionMode: 'public-download',
    },
    ...overrides,
  };
}

test('approved ingest-run policy is attached to market observations', () => {
  const result = enrichMarketObservationsWithProviderPolicy({
    observations: [observation()],
    ingestRuns: [run()],
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].providerPolicyKey, 'cardmarket-public-download');
  assert.equal(result.observations[0].acquisitionMode, 'public-download');
  assert.equal(result.rejected.length, 0);
});

test('observation without its ingest run fails closed', () => {
  const result = enrichMarketObservationsWithProviderPolicy({
    observations: [observation()],
    ingestRuns: [],
  });

  assert.equal(result.observations.length, 0);
  assert.equal(result.rejected[0].reason, 'ingest_run_unavailable');
});

test('source or snapshot mismatch fails closed', () => {
  const result = enrichMarketObservationsWithProviderPolicy({
    observations: [observation()],
    ingestRuns: [run({ sourceSnapshotId: 'different' })],
  });

  assert.equal(result.observations.length, 0);
  assert.equal(result.rejected[0].reason, 'ingest_run_source_mismatch');
});

test('blocked acquisition policy cannot enrich evidence for Fate Price', () => {
  const result = enrichMarketObservationsWithProviderPolicy({
    observations: [observation({ sourceName: 'pokemon-wizard' })],
    ingestRuns: [run({
      sourceName: 'pokemon-wizard',
      metadataJson: { providerPolicyKey: 'pokemon-wizard', acquisitionMode: 'website' },
    })],
  });

  assert.equal(result.observations.length, 0);
  assert.equal(result.rejected[0].reason, 'PRICING_SOURCE_BLOCKED');
});
