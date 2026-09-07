import assert from 'node:assert/strict';
import test from 'node:test';

import { runCobPipExactCardOfferCycle } from '../src/trader/value/cob-pip-exact-card-offers.mjs';

const SET_ID = 'fdset_40b2ad368841bbd285a0df18';

function fixtureState() {
  return {
    traderCatalogue: {
      tcgs: { tcg: { id: 'tcg', code: 'pokemon', name: 'Pokémon' } },
      series: { series: { id: 'series', tcgId: 'tcg', name: 'Mega Evolution', verificationStatus: 'verified' } },
      sets: { [SET_ID]: { id: SET_ID, tcgId: 'tcg', seriesId: 'series', name: 'Chaos Rising', verificationStatus: 'verified' } },
      printings: { weedle: { id: 'weedle', name: 'Weedle', verificationStatus: 'verified' } },
      cards: {
        card: {
          id: 'fdcard_weedle', tcgId: 'tcg', seriesId: 'series', setId: SET_ID, printingId: 'weedle',
          collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified',
        },
      },
      setSourceMappings: {}, cardSourceMappings: {}, cardProvenance: {},
    },
  };
}

function storeFixture() {
  const state = fixtureState();
  let mutations = 0;
  return {
    state,
    get mutations() { return mutations; },
    async read() { return state; },
    async mutate(work) { mutations += 1; return work(state); },
  };
}

function fetchFixture() {
  return async (url) => {
    assert.match(url, /pokemon-mega-evolution-chaos-rising\/products\.json/);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          products: [{
            id: 100,
            title: '#001 Weedle Mega Evolution Chaos Rising',
            handle: '001-weedle-mega-evolution-chaos-rising',
            image: { src: 'https://cdn.example/weedle.jpg' },
            variants: [{ id: 200, title: 'Base', price: '0.50', available: true }],
          }],
        };
      },
    };
  };
}

test('Cob & Pip cycle dry-runs exact resolution without writing', async () => {
  const store = storeFixture();
  const result = await runCobPipExactCardOfferCycle({
    store,
    collectionKeys: ['pokemon-chaos-rising'],
    fetchImpl: fetchFixture(),
    now: Date.parse('2026-09-07T12:00:00.000Z'),
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.verified, 1);
  assert.equal(result.buyableVerified, 1);
  assert.equal(store.mutations, 0);
});

test('write mode publishes only verified mappings without emitting market signals', async () => {
  const store = storeFixture();
  const result = await runCobPipExactCardOfferCycle({
    store,
    collectionKeys: ['pokemon-chaos-rising'],
    fetchImpl: fetchFixture(),
    now: Date.parse('2026-09-07T12:00:00.000Z'),
    write: true,
  });
  assert.equal(result.persistence.persisted, 1);
  assert.equal(Object.values(store.state.fatePriceRetailOfferMappings).length, 1);
  assert.equal(Object.values(store.state.fatePriceRetailOfferMappings)[0].cardIdentityId, 'fdcard_weedle');
  assert.equal(Object.values(store.state.offers)[0].stockQuantity, null);
  assert.equal(store.state.retailers['cob-and-pip'].healthy, true);
  assert.deepEqual(store.state.signals, undefined);
});

test('an offer already verified to another identity is quarantined at persistence', async () => {
  const store = storeFixture();
  const first = await runCobPipExactCardOfferCycle({
    store,
    collectionKeys: ['pokemon-chaos-rising'],
    fetchImpl: fetchFixture(),
    now: Date.parse('2026-09-07T12:00:00.000Z'),
    write: true,
  });
  const mapping = Object.values(store.state.fatePriceRetailOfferMappings)[0];
  store.state.fatePriceRetailOfferMappings = {
    conflict: { ...mapping, id: 'conflict', cardIdentityId: 'fdcard_someone_else', verificationStatus: 'verified' },
  };
  const second = await runCobPipExactCardOfferCycle({
    store,
    collectionKeys: ['pokemon-chaos-rising'],
    fetchImpl: fetchFixture(),
    now: Date.parse('2026-09-07T12:05:00.000Z'),
    write: true,
  });
  assert.equal(first.persistence.persisted, 1);
  assert.equal(second.persistence.persisted, 0);
  assert.equal(second.persistence.conflicts[0].reason, 'verified_offer_identity_conflict');
});
