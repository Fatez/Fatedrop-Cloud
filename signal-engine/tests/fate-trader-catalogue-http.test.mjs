import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFateTraderFlags } from '../src/trader/feature-flags.mjs';
import { handleFateTraderCatalogue } from '../src/trader/catalogue/http.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function catalogueStore() {
  return {
    async read() {
      return {
        traderCatalogue: {
          tcgs: { fdtcg_pokemon: { id: 'fdtcg_pokemon', code: 'pokemon', name: 'Pokémon TCG' } },
          series: {
            fdseries_1: { id: 'fdseries_1', tcgId: 'fdtcg_pokemon', name: 'Example Era', verificationStatus: 'verified' },
          },
          sets: {
            fdset_1: { id: 'fdset_1', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries_1', name: 'Example Set', verificationStatus: 'verified', releasedAt: 1000 },
          },
          setSourceMappings: {},
          printings: {
            fdprinting_1: { id: 'fdprinting_1', name: 'Examplemon', rarity: 'Rare', supertype: 'Pokémon', verificationStatus: 'verified' },
          },
          cards: {
            fdcard_verified: {
              id: 'fdcard_verified', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries_1', setId: 'fdset_1', printingId: 'fdprinting_1',
              collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified', verifiedAt: 1000,
            },
            fdcard_staged: {
              id: 'fdcard_staged', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries_1', setId: 'fdset_1', printingId: 'fdprinting_1',
              collectorNumber: '1', variantCode: 'reverse-holo', languageCode: 'en', verificationStatus: 'staged', verifiedAt: null,
            },
          },
          cardSourceMappings: {},
          cardProvenance: {},
        },
      };
    },
  };
}

const enabledFlags = Object.freeze({
  enabled: true,
  catalogueEnabled: true,
  collectionEnabled: false,
  binderEnabled: false,
  networkEnabled: false,
  matchingEnabled: false,
  huntsEnabled: false,
  messagingEnabled: false,
});

test('Fate Trader flags default dark and enforce dependency ordering', () => {
  assert.deepEqual(resolveFateTraderFlags({}), {
    enabled: false,
    catalogueEnabled: false,
    collectionEnabled: false,
    binderEnabled: false,
    networkEnabled: false,
    matchingEnabled: false,
    huntsEnabled: false,
    messagingEnabled: false,
  });

  const withoutMaster = resolveFateTraderFlags({ FATE_TRADER_CATALOGUE_ENABLED: 'true' });
  assert.equal(withoutMaster.catalogueEnabled, false);

  const collection = resolveFateTraderFlags({
    FATE_TRADER_ENABLED: 'true',
    FATE_TRADER_CATALOGUE_ENABLED: 'true',
    FATE_TRADER_COLLECTION_ENABLED: 'true',
  });
  assert.equal(collection.collectionEnabled, true);
  assert.equal(collection.binderEnabled, false);
  assert.equal(collection.networkEnabled, false);
  assert.equal(collection.matchingEnabled, false);
});

test('disabled catalogue route fails closed as unavailable', async () => {
  const res = responseRecorder();
  const handled = await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/cards', headers: { host: 'localhost' } },
    res,
    { store: catalogueStore(), flags: resolveFateTraderFlags({}) },
  );

  assert.equal(handled, true);
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
});

test('verified catalogue API never returns staged card identities', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/cards?setId=fdset_1', headers: { host: 'localhost' } },
    res,
    { store: catalogueStore(), flags: enabledFlags },
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.count, 1);
  assert.equal(res.body.data.cards[0].fateCardId, 'fdcard_verified');
});

test('exact card endpoint returns CARD_IDENTITY_NOT_VERIFIED for staged or unknown identity', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/cards/fdcard_staged', headers: { host: 'localhost' } },
    res,
    { store: catalogueStore(), flags: enabledFlags },
  );

  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'CARD_IDENTITY_NOT_VERIFIED');
});

test('series and set routes expose only the canonical browse hierarchy', async () => {
  const seriesRes = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/card-series?tcg=pokemon', headers: { host: 'localhost' } },
    seriesRes,
    { store: catalogueStore(), flags: enabledFlags },
  );
  assert.equal(seriesRes.body.data.series[0].name, 'Example Era');

  const setsRes = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/card-sets?seriesId=fdseries_1', headers: { host: 'localhost' } },
    setsRes,
    { store: catalogueStore(), flags: enabledFlags },
  );
  assert.equal(setsRes.body.data.sets[0].name, 'Example Set');
});
