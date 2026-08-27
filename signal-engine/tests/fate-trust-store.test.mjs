import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTrustProfileFromStore,
  recordTrustEvidenceInStore,
  TRUST_EVIDENCE_STATUSES,
  TRUST_EVIDENCE_TYPES,
} from '../src/trader/trust/store.mjs';

function memoryStore() {
  const state = {
    traderUsers: {
      'user-a': { id: 'user-a', createdAt: Date.now() - (400 * 86_400_000) },
    },
  };
  return {
    state,
    async read() { return state; },
    async mutate(fn) { return fn(state); },
  };
}

test('unsubstantiated negative reports are retained but do not alter FateTrust', async () => {
  const store = memoryStore();
  await recordTrustEvidenceInStore(store, {
    userId: 'user-a',
    evidenceType: TRUST_EVIDENCE_TYPES.HUB_TRADE,
    status: TRUST_EVIDENCE_STATUSES.VERIFIED,
    counterpartyUserId: 'user-b',
  });
  const before = await getTrustProfileFromStore(store, { userId: 'user-a' });

  await recordTrustEvidenceInStore(store, {
    userId: 'user-a',
    evidenceType: TRUST_EVIDENCE_TYPES.SIGNIFICANT_DISPUTE,
    status: TRUST_EVIDENCE_STATUSES.UNSUBSTANTIATED,
    counterpartyUserId: 'user-c',
  });
  const after = await getTrustProfileFromStore(store, { userId: 'user-a' });

  assert.equal(after.score, before.score);
  assert.equal(after.penalties, before.penalties);
  assert.equal(after.evidenceCounts.substantiatedSignificantDisputes, 0);
  assert.equal(store.state.traderTrust.evidence.length, 2);
});

test('substantiated adverse outcomes reduce score and confirmed fraud independently restricts the account', async () => {
  const store = memoryStore();
  for (let i = 0; i < 12; i += 1) {
    await recordTrustEvidenceInStore(store, {
      userId: 'user-a',
      evidenceType: TRUST_EVIDENCE_TYPES.HUB_TRADE,
      status: TRUST_EVIDENCE_STATUSES.VERIFIED,
      counterpartyUserId: `counterparty-${i}`,
      tradeValuePence: 10_000,
    });
  }
  const healthy = await getTrustProfileFromStore(store, { userId: 'user-a' });

  await recordTrustEvidenceInStore(store, {
    userId: 'user-a',
    evidenceType: TRUST_EVIDENCE_TYPES.SIGNIFICANT_DISPUTE,
    status: TRUST_EVIDENCE_STATUSES.SUBSTANTIATED,
  });
  const penalized = await getTrustProfileFromStore(store, { userId: 'user-a' });
  assert.ok(penalized.score < healthy.score);
  assert.equal(penalized.evidenceCounts.substantiatedSignificantDisputes, 1);

  await recordTrustEvidenceInStore(store, {
    userId: 'user-a',
    evidenceType: TRUST_EVIDENCE_TYPES.CONFIRMED_FRAUD,
    status: TRUST_EVIDENCE_STATUSES.SUBSTANTIATED,
  });
  const restricted = await getTrustProfileFromStore(store, { userId: 'user-a' });
  assert.equal(restricted.restricted, true);
  assert.equal(restricted.level, 'restricted');
});

test('dedupe keys make server-owned trust evidence idempotent', async () => {
  const store = memoryStore();
  const input = {
    userId: 'user-a',
    evidenceType: TRUST_EVIDENCE_TYPES.TRACKED_POSTAL_TRADE,
    status: TRUST_EVIDENCE_STATUSES.VERIFIED,
    counterpartyUserId: 'user-b',
    dedupeKey: 'exchange:123:user:user-a:completed',
  };
  await recordTrustEvidenceInStore(store, input);
  await recordTrustEvidenceInStore(store, input);
  const profile = await getTrustProfileFromStore(store, { userId: 'user-a' });
  assert.equal(profile.evidenceCounts.trackedPostalTrades, 1);
  assert.equal(store.state.traderTrust.evidence.length, 1);
});
