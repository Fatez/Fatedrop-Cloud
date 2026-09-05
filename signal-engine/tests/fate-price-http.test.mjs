import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFateTraderCatalogue, isFateTraderCataloguePath } from '../src/trader/catalogue/http.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function storeWithPriceEvidence() {
  const now = Date.now();
  const earlier = now - (7 * 24 * 60 * 60 * 1000);
  return {
    async read() {
      return {
        traderCatalogue: {
          tcgs: { fdtcg_pokemon: { id: 'fdtcg_pokemon', code: 'pokemon', name: 'Pokémon TCG' } },
          series: { fdseries_1: { id: 'fdseries_1', tcgId: 'fdtcg_pokemon', name: 'Example', verificationStatus: 'verified' } },
          sets: { fdset_1: { id: 'fdset_1', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries_1', name: 'Example Set', verificationStatus: 'verified' } },
          printings: { fdprinting_1: { id: 'fdprinting_1', name: 'Examplemon', verificationStatus: 'verified' } },
          cards: {
            fdcard_1: {
              id: 'fdcard_1', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries_1', setId: 'fdset_1', printingId: 'fdprinting_1',
              collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified', verifiedAt: now,
            },
          },
          cardSourceMappings: {},
          cardProvenance: {},
          setSourceMappings: {},
        },
        fateValueLab: {
          observations: {
            obs_0: {
              id: 'obs_0', cardIdentityId: 'fdcard_1', sourceName: 'cardmarket', sourceSnapshotId: 'snapshot_0',
              marketSegmentKey: 'standard', conditionCode: 'unspecified', currencyCode: 'EUR',
              sourceEffectiveAt: earlier, observedAt: earlier,
              marketDay: new Date(earlier).toISOString().slice(0, 10),
              trendPrice: 8, avg7d: 9, avg30d: 10, avg1d: 20, lowPrice: 3,
            },
            obs_1: {
              id: 'obs_1', cardIdentityId: 'fdcard_1', sourceName: 'cardmarket', sourceSnapshotId: 'snapshot_1',
              marketSegmentKey: 'standard', conditionCode: 'unspecified', currencyCode: 'EUR',
              sourceEffectiveAt: now - 3_600_000, observedAt: now - 3_600_000,
              marketDay: new Date(now - 3_600_000).toISOString().slice(0, 10),
              trendPrice: 10, avg7d: 11, avg30d: 12, avg1d: 30, lowPrice: 4,
            },
          },
        },
      };
    },
  };
}

const darkFlags = Object.freeze({
  enabled: false,
  catalogueEnabled: false,
  collectionEnabled: false,
  binderEnabled: false,
  networkEnabled: false,
  matchingEnabled: false,
  huntsEnabled: false,
  messagingEnabled: false,
  trustEnabled: false,
  safeExchangeEnabled: false,
});

test('Fate Price routes are recognised as Cloud catalogue-adjacent reads', () => {
  assert.equal(isFateTraderCataloguePath('/v1/fate-price/fdcard_1'), true);
  assert.equal(isFateTraderCataloguePath('/v1/fate-price'), true);
  assert.equal(isFateTraderCataloguePath('/v1/fate-price/cards'), true);
  assert.equal(isFateTraderCataloguePath('/v1/fate-price/cards/fdcard_1'), true);
  assert.equal(isFateTraderCataloguePath('/v1/fate-price/fdcard_1/history'), true);
});

test('Fate Price verified-card discovery stays available while Trader catalogue remains dark', async () => {
  const search = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/cards?q=Example', headers: { host: 'localhost' } },
    search,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(search.status, 200);
  assert.equal(search.body.data.count, 1);
  assert.equal(search.body.data.cards[0].id, 'fdcard_1');

  const exact = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/cards/fdcard_1', headers: { host: 'localhost' } },
    exact,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(exact.status, 200);
  assert.equal(exact.body.data.card.name, 'Examplemon');

  const trader = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/cards?q=Example', headers: { host: 'localhost' } },
    trader,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(trader.status, 404);
});

test('Fate Price discovery requires a bounded search or exact set', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/cards', headers: { host: 'localhost' } },
    res,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'FATE_PRICE_CARD_FILTER_REQUIRED');
});

test('single-card Fate Price is available independently of Fate Trader UI flags', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/fdcard_1', headers: { host: 'localhost' } },
    res,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.fatePrice.available, true);
  assert.equal(res.body.data.fatePrice.price.amount, 11);
  assert.equal(res.body.data.fatePrice.price.currencyCode, 'EUR');
});

test('batch Fate Price supports collector valuation without per-card HTTP fan-out', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price?ids=fdcard_1,fdcard_missing', headers: { host: 'localhost' } },
    res,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.count, 2);
  assert.equal(res.body.data.prices[0].available, true);
  assert.equal(res.body.data.prices[1].available, false);
});

test('single-card Fate Price still requires verified canonical card identity', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/not-a-card', headers: { host: 'localhost' } },
    res,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'CARD_IDENTITY_NOT_VERIFIED');
});

test('batch Fate Price requires explicit exact card IDs', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price', headers: { host: 'localhost' } },
    res,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'FATE_PRICE_CARD_IDS_REQUIRED');
});

test('Fate Price history exposes real stored market-day points without client reconstruction', async () => {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/fdcard_1/history?days=30', headers: { host: 'localhost' } },
    res,
    { store: storeWithPriceEvidence(), flags: darkFlags },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.history.available, true);
  assert.equal(res.body.data.history.days, 30);
  assert.equal(res.body.data.history.points.length, 2);
  assert.deepEqual(res.body.data.history.points.map((point) => point.amount), [9, 11]);
  assert.equal(res.body.data.history.evidence.pointPolicy, 'stored_market_days_only_no_interpolation');
});
