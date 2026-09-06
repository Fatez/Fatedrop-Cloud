import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFateTraderCatalogue } from '../src/trader/catalogue/http.mjs';
import {
  classifyFatePriceRetailComparison,
  getFatePriceRetailOffersFromStore,
} from '../src/trader/value/fate-price-retail.mjs';

function price({ level = 'high' } = {}) {
  return {
    available: true,
    price: { amount: 100, fairLow: 90, fairHigh: 110, currencyCode: 'GBP', asOf: Date.now() },
    confidence: { level },
  };
}

test('retail verdict compares delivered total with the exact FatePrice fair range', () => {
  assert.equal(classifyFatePriceRetailComparison({ deliveredAmount: 89, fatePrice: price() }).status, 'good_price');
  assert.equal(classifyFatePriceRetailComparison({ deliveredAmount: 100, fatePrice: price() }).status, 'fair_price');
  assert.equal(classifyFatePriceRetailComparison({ deliveredAmount: 111, fatePrice: price() }).status, 'high_price');
  const good = classifyFatePriceRetailComparison({ deliveredAmount: 80, fatePrice: price() });
  assert.equal(good.differenceAmount, -20);
  assert.equal(good.differencePercent, -20);
});

test('retail verdict fails closed without delivered price or sufficient FatePrice confidence', () => {
  assert.equal(classifyFatePriceRetailComparison({ deliveredAmount: null, fatePrice: price() }).reason, 'DELIVERED_PRICE_UNKNOWN');
  assert.equal(classifyFatePriceRetailComparison({ deliveredAmount: 80, fatePrice: price({ level: 'low' }) }).reason, 'FATE_PRICE_CONFIDENCE_TOO_LOW');
});

function stateStore() {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const offer = (id, pricePence, postagePence, overrides = {}) => ({
    offerId: id,
    retailerId: `retailer-${id}`,
    retailerName: `Retailer ${id}`,
    retailerSku: `sku-${id}`,
    title: 'Examplemon 1/100 Standard English',
    url: `https://retailer.example/${id}`,
    imageUrl: null,
    pricePence,
    postagePence,
    stockStatus: 'in_stock',
    stockConfidence: 0.99,
    stockQuantity: 1,
    lastSeenAt: seconds - 60,
    ...overrides,
  });
  const offers = {
    good: offer('good', 8000, 0),
    fair: offer('fair', 9500, 500),
    high: offer('high', 11500, 500),
    stale: offer('stale', 7000, 0, { lastSeenAt: seconds - 7200 }),
    unknownDelivery: offer('unknownDelivery', 8500, null),
  };
  const mappings = Object.fromEntries(Object.keys(offers).map((key) => [key, {
    id: `mapping-${key}`,
    cardIdentityId: 'fdcard_1',
    offerId: key,
    marketSegmentKey: 'standard',
    conditionCode: 'unspecified',
    languageCode: 'en',
    verificationStatus: 'verified',
    verifiedAt: now - 10_000,
  }]));
  return {
    async read() {
      return {
        traderCatalogue: {
          tcgs: { tcg: { id: 'tcg', code: 'pokemon', name: 'Pokémon' } },
          series: { series: { id: 'series', tcgId: 'tcg', name: 'Example', verificationStatus: 'verified' } },
          sets: { set: { id: 'set', tcgId: 'tcg', seriesId: 'series', name: 'Example Set', verificationStatus: 'verified' } },
          printings: { printing: { id: 'printing', name: 'Examplemon', rarity: 'Common', verificationStatus: 'verified' } },
          cards: { fdcard_1: { id: 'fdcard_1', tcgId: 'tcg', seriesId: 'series', setId: 'set', printingId: 'printing', collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified' } },
          setSourceMappings: {}, cardSourceMappings: {}, cardProvenance: {},
        },
        fateValueLab: {
          observations: {
            current: {
              id: 'current', cardIdentityId: 'fdcard_1', sourceName: 'cardmarket', sourceSnapshotId: 'snapshot',
              marketSegmentKey: 'standard', conditionCode: 'unspecified', currencyCode: 'GBP',
              sourceEffectiveAt: now - 60_000, observedAt: now - 60_000,
              marketDay: new Date(now - 60_000).toISOString().slice(0, 10),
              marketPrice: 100, trendPrice: 100, avg7d: 90, avg30d: 110, lowPrice: 85,
            },
          },
        },
        fatePriceRetailOfferMappings: mappings,
        offers,
        retailers: Object.fromEntries(Object.values(offers).map((row) => [row.retailerId, { id: row.retailerId, healthy: true }])),
      };
    },
  };
}

test('retail service exposes only fresh verified exact mappings and Cloud-owned verdicts', async () => {
  const retail = await getFatePriceRetailOffersFromStore(stateStore(), { cardIdentityId: 'fdcard_1' });
  assert.equal(retail.status, 'available');
  assert.deepEqual(retail.offers.map((offer) => offer.offerId), ['good', 'fair', 'high', 'unknownDelivery']);
  assert.equal(retail.offers.some((offer) => offer.offerId === 'stale'), false);
  assert.equal(retail.offers.find((offer) => offer.offerId === 'good').comparison.status, 'good_price');
  assert.equal(retail.offers.find((offer) => offer.offerId === 'fair').comparison.status, 'fair_price');
  assert.equal(retail.offers.find((offer) => offer.offerId === 'high').comparison.status, 'high_price');
  assert.equal(retail.offers.find((offer) => offer.offerId === 'unknownDelivery').comparison.status, 'unavailable');
});

function responseRecorder() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('FatePrice exact-card retail endpoint remains available independently of Trader UI flags', async () => {
  const response = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url: '/v1/fate-price/fdcard_1/offers', headers: { host: 'localhost' } },
    response,
    { store: stateStore(), flags: { enabled: false, catalogueEnabled: false } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.data.card.id, 'fdcard_1');
  assert.equal(response.body.data.retail.contractVersion, 1);
  assert.equal(response.body.data.retail.offers[0].comparison.status, 'good_price');
});
