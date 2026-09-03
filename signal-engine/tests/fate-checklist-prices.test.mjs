import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklistPrintingValues } from '../src/trader/value/checklist-prices.mjs';

function card(id, printingId, languageCode, variantCode) {
  return {
    id,
    fateCardId: id,
    setId: 'set-1',
    printingId,
    collectorNumber: printingId,
    name: id,
    languageCode,
    variantCode,
    verificationStatus: 'verified',
  };
}

function price(id, amount) {
  return {
    status: 'available',
    valuationKind: 'raw-market',
    fateCardId: id,
    cardIdentityId: id,
    amount,
    currencyCode: 'EUR',
    sourceName: 'cardmarket',
    providerPolicyKey: 'cardmarket-public-download',
    metricUsed: 'trendPrice',
    confidence: 'high',
    sourceEffectiveAt: 100,
  };
}

test('checklist pricing uses the requested language and variant representative only', () => {
  const canonicalCards = [
    card('p1-en-standard', 'p1', 'en', 'standard'),
    card('p1-en-reverse', 'p1', 'en', 'reverse'),
    card('p1-jp-standard', 'p1', 'ja', 'standard'),
    card('p2-en-standard', 'p2', 'en', 'standard'),
  ];

  const result = buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards,
    fatePrices: [
      price('p1-en-standard', 10),
      price('p1-en-reverse', 100),
      price('p1-jp-standard', 200),
      price('p2-en-standard', 20),
    ],
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
  });

  assert.equal(result.printingValues.length, 2);
  assert.equal(result.printingValues.find((row) => row.printingId === 'p1').amount, 10);
  assert.equal(result.printingValues.find((row) => row.printingId === 'p2').amount, 20);
});

test('missing price for preferred identity stays unpriced instead of borrowing another variant price', () => {
  const canonicalCards = [
    card('p1-en-standard', 'p1', 'en', 'standard'),
    card('p1-en-reverse', 'p1', 'en', 'reverse'),
  ];

  const result = buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards,
    fatePrices: [price('p1-en-reverse', 100)],
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
  });

  assert.equal(result.printingValues.length, 0);
  assert.equal(result.unpricedRepresentatives[0].fateCardId, 'p1-en-standard');
  assert.equal(result.unpricedRepresentatives[0].reason, 'fate_price_unavailable');
});

test('missing preferred language fails closed for that printing', () => {
  const canonicalCards = [card('p1-jp-standard', 'p1', 'ja', 'standard')];

  const result = buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards,
    fatePrices: [price('p1-jp-standard', 10)],
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
  });

  assert.equal(result.printingValues.length, 0);
  assert.equal(result.unpricedRepresentatives[0].reason, 'preferred_language_unavailable');
});

test('preferred language is required so valuation never infers language from market or user location', () => {
  assert.throws(() => buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards: [],
    fatePrices: [],
    currencyCode: 'EUR',
  }), /preferredLanguageCode/);
});
