import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { handleFateTraderBinder } from '../src/trader/binder/http.mjs';

const SEEKER = 'user_seeker_private';
const CANDIDATE = 'user_candidate_private';
const CARD_HAVE = 'fdcard_have_exact';
const CARD_WANT = 'fdcard_want_exact';
const FLAGS = Object.freeze({
  enabled: true,
  catalogueEnabled: true,
  collectionEnabled: true,
  binderEnabled: true,
  networkEnabled: true,
  matchingEnabled: true,
  huntsEnabled: false,
  messagingEnabled: false,
});

function request(method, url) {
  return { method, url, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() {} };
}
function response() {
  return { status: null, body: null, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
}
const seekerUser = async () => ({ id: SEEKER, fateId: 'FD-SEEKER' });

async function seededStore({ candidateVisibility = 'network' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-finder-http-'));
  const store = new FileStore(path.join(dir, 'store.json'));
  const now = Date.now();
  await store.mutate((state) => {
    state.traderCollection = {
      collections: {
        seeker_collection: { id: 'seeker_collection', userId: SEEKER, tcgId: 'fdtcg_pokemon', visibility: 'private', createdAt: now, updatedAt: now },
        candidate_collection: { id: 'candidate_collection', userId: CANDIDATE, tcgId: 'fdtcg_pokemon', visibility: 'private', createdAt: now, updatedAt: now },
      },
      items: {
        seeker_owned: { id: 'seeker_owned', collectionId: 'seeker_collection', fateCardId: CARD_HAVE, quantity: 1, tradeQuantity: 1, copyState: 'raw', conditionCode: 'near_mint', notes: 'private seeker note', status: 'active', revision: 1, createdAt: now, updatedAt: now },
        candidate_owned: { id: 'candidate_owned', collectionId: 'candidate_collection', fateCardId: CARD_WANT, quantity: 1, tradeQuantity: 1, copyState: 'raw', conditionCode: 'near_mint', notes: 'private candidate note', status: 'active', revision: 1, createdAt: now, updatedAt: now },
      },
      grading: {},
      media: {},
      wants: {
        seeker_want: { id: 'seeker_want', userId: SEEKER, cardIdentityId: CARD_WANT, quantity: 1, active: true, createdAt: now, updatedAt: now },
        candidate_want: { id: 'candidate_want', userId: CANDIDATE, cardIdentityId: CARD_HAVE, quantity: 1, active: true, createdAt: now, updatedAt: now },
      },
      events: [],
    };
    state.traderBinder = {
      binders: {
        seeker_binder: { id: 'seeker_binder', userId: SEEKER, tcgId: 'fdtcg_pokemon', visibility: 'network', status: 'active', localTradeAllowed: true, postalTradeAllowed: true, createdAt: now, updatedAt: now },
        candidate_binder: { id: 'candidate_binder', userId: CANDIDATE, tcgId: 'fdtcg_pokemon', visibility: 'network', status: 'active', localTradeAllowed: true, postalTradeAllowed: true, createdAt: now, updatedAt: now },
      },
      items: {
        seeker_trade_item: { id: 'seeker_trade_item', binderId: 'seeker_binder', collectionItemId: 'seeker_owned', status: 'available', tradeMode: 'open', visibility: 'network', localTradeAllowed: true, postalTradeAllowed: true, notes: 'private binder seeker note', revision: 1, createdAt: now, updatedAt: now },
        candidate_trade_item: { id: 'candidate_trade_item', binderId: 'candidate_binder', collectionItemId: 'candidate_owned', status: 'available', tradeMode: 'exact_wants_only', visibility: candidateVisibility, localTradeAllowed: true, postalTradeAllowed: true, notes: 'private binder candidate note', revision: 1, createdAt: now, updatedAt: now },
      },
      events: [],
      wantConstraints: {},
    };
  });
  return store;
}

test('Fate Trade Finder stays dark until network and matching flags are enabled', async () => {
  const res = response();
  await handleFateTraderBinder(request('GET', '/v1/trader/finder'), res, {
    store: await seededStore(),
    flags: { ...FLAGS, matchingEnabled: false },
    resolveUser: seekerUser,
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('Fate Trade Finder requires the existing FateDrop session', async () => {
  const res = response();
  await handleFateTraderBinder(request('GET', '/v1/trader/finder'), res, {
    store: await seededStore(),
    flags: FLAGS,
    resolveUser: async () => null,
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'AUTH_REQUIRED');
});

test('exact reciprocal network intent becomes privacy-safe FATE TRADE FOUND', async () => {
  const res = response();
  await handleFateTraderBinder(request('GET', '/v1/trader/finder'), res, {
    store: await seededStore(),
    flags: FLAGS,
    resolveUser: seekerUser,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.count, 1);
  const opportunity = res.body.data.opportunities[0];
  assert.equal(opportunity.opportunityClass, 'exact_trade_found');
  assert.equal(opportunity.headline, 'FATE TRADE FOUND');
  assert.equal(opportunity.fateTradeFoundEligible, true);
  assert.equal(opportunity.targetCardId, CARD_WANT);
  assert.equal(opportunity.offeredTargetCardId, CARD_WANT);
  assert.equal(opportunity.reciprocalMatchCount, 1);

  const raw = JSON.stringify(res.body);
  assert.equal(raw.includes(SEEKER), false);
  assert.equal(raw.includes(CANDIDATE), false);
  assert.equal(raw.includes('private seeker note'), false);
  assert.equal(raw.includes('private candidate note'), false);
  assert.equal(raw.includes('candidate_want'), false);
  assert.equal(raw.includes('reciprocalEvidence'), false);
});

test('private candidate Binder items never enter Finder matching', async () => {
  const res = response();
  await handleFateTraderBinder(request('GET', '/v1/trader/finder'), res, {
    store: await seededStore({ candidateVisibility: 'private' }),
    flags: FLAGS,
    resolveUser: seekerUser,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.count, 0);
  assert.equal(res.body.data.networkOffersConsidered, 0);
});
