import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actOnSafeExchangeInStore,
  approveFateHubInStore,
  createSafeExchangeInStore,
  issueHubSessionInStore,
} from '../src/trader/safe-exchange/store.mjs';
import { getTrustProfileFromStore } from '../src/trader/trust/store.mjs';

const START = Date.parse('2026-08-27T01:00:00Z');

function memoryStore() {
  const state = {
    traderUsers: {
      'user-a': { id: 'user-a', createdAt: START - 400 * 86_400_000 },
      'user-b': { id: 'user-b', createdAt: START - 300 * 86_400_000 },
    },
    traderCollection: {
      collections: {
        'collection-a': { id: 'collection-a', userId: 'user-a' },
        'collection-b': { id: 'collection-b', userId: 'user-b' },
      },
      items: {
        'item-a': { id: 'item-a', collectionId: 'collection-a', fateCardId: 'card-a', quantity: 1, tradeQuantity: 1, status: 'active' },
        'item-b': { id: 'item-b', collectionId: 'collection-b', fateCardId: 'card-b', quantity: 1, tradeQuantity: 1, status: 'active' },
      },
      grading: {},
    },
  };
  return {
    state,
    async read() { return state; },
    async mutate(fn) { return fn(state); },
  };
}

function commitments() {
  return {
    partyACommitment: {
      assets: [{ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'raw', conditionCode: 'near_mint' }],
    },
    partyBCommitment: {
      assets: [{ collectionItemId: 'item-b', fateCardId: 'card-b', quantity: 1, copyState: 'raw', conditionCode: 'near_mint' }],
    },
  };
}

test('postal Safe Exchange persists dual agreement, tracked dispatch, inspection and completion evidence', async () => {
  const store = memoryStore();
  const created = await createSafeExchangeInStore(store, {
    userId: 'user-a',
    now: START,
    input: { partyBUserId: 'user-b', method: 'postal', ...commitments() },
  });
  assert.equal(created.state, 'draft');
  assert.equal(created.partyACommitment.assets[0].collectionItemId, 'item-a');

  const oneAgreed = await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'agree', now: START + 1 });
  assert.equal(oneAgreed.state, 'draft');
  const agreed = await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'agree', now: START + 2 });
  assert.equal(agreed.state, 'agreed');

  await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'dispatch', body: { trackingRef: 'TRACK-A' }, now: START + 3 });
  const inTransit = await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'dispatch', body: { trackingRef: 'TRACK-B' }, now: START + 4 });
  assert.equal(inTransit.state, 'in_transit');

  await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'delivered', now: START + 5 });
  await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'delivered', now: START + 6 });
  await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'inspect', now: START + 7 });
  const inspected = await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'inspect', now: START + 8 });
  assert.equal(inspected.state, 'inspected');

  const confirming = await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'begin_confirmation', now: START + 9 });
  assert.equal(confirming.state, 'confirming');
  const oneConfirmed = await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'confirm', now: START + 10 });
  assert.equal(oneConfirmed.state, 'confirming');
  const completed = await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'confirm', now: START + 11 });
  assert.equal(completed.state, 'completed');

  const trustA = await getTrustProfileFromStore(store, { userId: 'user-a', now: START + 12 });
  const trustB = await getTrustProfileFromStore(store, { userId: 'user-b', now: START + 12 });
  assert.equal(trustA.evidenceCounts.trackedPostalTrades, 1);
  assert.equal(trustB.evidenceCounts.trackedPostalTrades, 1);
});

test('Safe Exchange rejects a commitment to somebody else\'s collection item', async () => {
  const store = memoryStore();
  await assert.rejects(() => createSafeExchangeInStore(store, {
    userId: 'user-a',
    now: START,
    input: {
      partyBUserId: 'user-b',
      method: 'postal',
      partyACommitment: { assets: [{ collectionItemId: 'item-b', fateCardId: 'card-b', quantity: 1, copyState: 'raw', conditionCode: 'near_mint' }] },
      partyBCommitment: commitments().partyBCommitment,
    },
  }), (error) => error.code === 'COMMITMENT_NOT_OWNED');
});

test('Hub check-in requires an approved physical hub and the exact short-lived server token', async () => {
  const store = memoryStore();
  await approveFateHubInStore(store, { hubId: 'hub-1', now: START });
  const created = await createSafeExchangeInStore(store, {
    userId: 'user-a',
    now: START + 1,
    input: { partyBUserId: 'user-b', method: 'hub', hubId: 'hub-1', ...commitments() },
  });
  await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'agree', now: START + 2 });
  await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'agree', now: START + 3 });

  const proof = await issueHubSessionInStore(store, { exchangeId: created.id, hubId: 'hub-1', ttlMs: 5 * 60 * 1000, now: START + 4 });
  await assert.rejects(() => actOnSafeExchangeInStore(store, {
    userId: 'user-a', exchangeId: created.id, action: 'check_in', body: { hubProof: { ...proof, token: 'wrong-token' } }, now: START + 5,
  }), (error) => error.code === 'HUB_PROOF_INVALID');

  const first = await actOnSafeExchangeInStore(store, { userId: 'user-a', exchangeId: created.id, action: 'check_in', body: { hubProof: proof }, now: START + 6 });
  assert.equal(first.state, 'agreed');
  const second = await actOnSafeExchangeInStore(store, { userId: 'user-b', exchangeId: created.id, action: 'check_in', body: { hubProof: proof }, now: START + 7 });
  assert.equal(second.state, 'checked_in');
  assert.equal(store.state.traderSafeExchange.hubSessions[proof.sessionId].usedAt, START + 7);
});
