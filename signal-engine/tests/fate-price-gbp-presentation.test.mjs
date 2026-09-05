import assert from 'node:assert/strict';
import test from 'node:test';

import { createEcbFxClient, FxRateUnavailableError, parseEcbRates } from '../src/trader/value/ecb-fx.mjs';
import { presentFatePrice, presentFatePriceHistory } from '../src/trader/value/fate-price-presentation.mjs';
import { getFatePriceFromStore, getPresentedFatePriceFromStore } from '../src/trader/value/fate-price-service.mjs';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const CARD_ID = 'pokemon:test:001:standard:en';

function observation(id, day, amount) {
  const at = Date.parse(`${day}T09:00:00.000Z`);
  return {
    id,
    cardIdentityId: CARD_ID,
    sourceName: 'cardmarket',
    sourceSnapshotId: `snapshot-${day}`,
    sourceRecordId: '123',
    sourceVariantKey: 'standard',
    marketSegmentKey: 'default',
    conditionCode: 'unspecified',
    currencyCode: 'EUR',
    observedAt: at,
    sourceEffectiveAt: at,
    marketDay: day,
    marketPrice: amount,
    trendPrice: amount,
    avg7d: amount,
    avg30d: amount,
    lowPrice: amount - 2,
  };
}

function fileStore() {
  return {
    async read() {
      return {
        traderCatalogue: { cards: { [CARD_ID]: { verificationStatus: 'verified' } } },
        fateValueLab: {
          observations: {
            previous: observation('previous', '2026-08-29', 40),
            current: observation('current', '2026-09-05', 50),
          },
        },
      };
    },
  };
}

const fixedFx = Object.freeze({
  async getRate({ at }) {
    const day = new Date(Number(at)).toISOString().slice(0, 10);
    return Object.freeze({
      sourceName: 'ecb_reference_rates',
      sourceUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
      baseCurrencyCode: 'EUR',
      quoteCurrencyCode: 'GBP',
      rate: day === '2026-08-29' ? 0.84 : 0.85,
      rateDate: day,
      requestedDay: day,
      fetchedAt: NOW,
    });
  },
});

test('ECB parser and client resolve the latest prior dated GBP reference rate', async () => {
  const xml = `<?xml version="1.0"?><Envelope><Cube><Cube time="2026-09-04"><Cube currency="USD" rate="1.2"/><Cube currency="GBP" rate="0.8512"/></Cube><Cube time="2026-09-03"><Cube currency="GBP" rate="0.8499"/></Cube></Cube></Envelope>`;
  assert.equal(parseEcbRates(xml).get('2026-09-04'), 0.8512);
  const client = createEcbFxClient({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }),
    now: () => NOW,
  });
  const rate = await client.getRate({ fromCurrencyCode: 'EUR', toCurrencyCode: 'GBP', at: Date.parse('2026-09-05T10:00:00Z') });
  assert.equal(rate.rate, 0.8512);
  assert.equal(rate.rateDate, '2026-09-04');
  assert.equal(rate.requestedDay, '2026-09-05');
});

test('GBP presentation converts current FatePrice while retaining raw EUR and native movement', async () => {
  const store = fileStore();
  const native = await getFatePriceFromStore(store, { cardIdentityId: CARD_ID, currencyCode: 'EUR', now: NOW });
  const gbp = await getPresentedFatePriceFromStore(store, {
    cardIdentityId: CARD_ID,
    currencyCode: 'EUR',
    displayCurrencyCode: 'GBP',
    fxClient: fixedFx,
    now: NOW,
  });

  assert.equal(native.price.amount, 50);
  assert.equal(native.price.currencyCode, 'EUR');
  assert.equal(gbp.price.amount, 42.5);
  assert.equal(gbp.price.currencyCode, 'GBP');
  assert.deepEqual(gbp.sourcePrice, native.price);
  assert.equal(gbp.fx.rate, 0.85);
  assert.equal(gbp.fx.sourceName, 'ecb_reference_rates');
  assert.deepEqual(gbp.movement, native.movement);
  assert.equal(gbp.movement.d7.percent, 25);
  assert.equal(gbp.movementCurrencyCode, 'EUR');
});

test('missing FX fails closed instead of relabelling EUR as GBP', async () => {
  const source = await getFatePriceFromStore(fileStore(), { cardIdentityId: CARD_ID, currencyCode: 'EUR', now: NOW });
  const unavailableFx = { async getRate() { throw new FxRateUnavailableError('no dated rate'); } };
  const result = await presentFatePrice(source, { displayCurrencyCode: 'GBP', fxClient: unavailableFx });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'FX_RATE_UNAVAILABLE');
  assert.equal(result.price, null);
  assert.equal(result.sourcePrice.amount, 50);
  assert.equal(result.sourcePrice.currencyCode, 'EUR');
});

test('history converts each stored market day with its own dated FX rate and preserves source points', async () => {
  const history = Object.freeze({
    contractVersion: 1,
    policyVersion: 'fate-price-v1',
    cardIdentityId: CARD_ID,
    available: true,
    reason: null,
    days: 7,
    marketScope: Object.freeze({ currencyCode: 'EUR', marketSegmentKey: 'default', conditionCode: 'unspecified' }),
    points: Object.freeze([
      Object.freeze({ marketDay: '2026-08-29', asOf: Date.parse('2026-08-29T09:00:00Z'), amount: 40, currencyCode: 'EUR', fairLow: 39, fairHigh: 41, guideLow: 38, confidence: 'medium', sourceCount: 1 }),
      Object.freeze({ marketDay: '2026-09-05', asOf: Date.parse('2026-09-05T09:00:00Z'), amount: 50, currencyCode: 'EUR', fairLow: 49, fairHigh: 51, guideLow: 48, confidence: 'medium', sourceCount: 1 }),
    ]),
    evidence: Object.freeze({ availableScopes: Object.freeze([]), requestedScope: null, pointPolicy: 'stored_market_days_only_no_interpolation' }),
  });
  const result = await presentFatePriceHistory(history, { displayCurrencyCode: 'GBP', fxClient: fixedFx });
  assert.deepEqual(result.points.map((point) => point.amount), [33.6, 42.5]);
  assert.ok(result.points.every((point) => point.currencyCode === 'GBP'));
  assert.deepEqual(result.sourcePoints, history.points);
  assert.deepEqual(result.fx.map((row) => row.rate), [0.84, 0.85]);
});
