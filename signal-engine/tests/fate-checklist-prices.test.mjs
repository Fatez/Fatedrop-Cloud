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

function price(id, amount, valuationKind='raw-market', sourceEffectiveAt=100) {
  return {
    status: 'available',
    valuationKind,
    fateCardId: id,
    cardIdentityId: id,
    amount,
    currencyCode: 'EUR',
    sourceName: valuationKind==='fair-price'?'fatedrop-fair-price':'cardmarket',
    providerPolicyKey: valuationKind==='fair-price'?null:'cardmarket-public-download',
    metricUsed: valuationKind==='fair-price'?'fair-price-v1':'trendPrice',
    confidence: 'high',
    sourceEffectiveAt,
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

test('calibrated Fair Price wins over newer raw Known Price for the exact checklist identity',()=>{
  const canonicalCards=[card('p1-en-standard','p1','en','standard')];
  const result=buildChecklistPrintingValues({
    setId:'set-1',
    canonicalCards,
    fatePrices:[
      price('p1-en-standard',99,'raw-market',300),
      price('p1-en-standard',42,'fair-price',200),
    ],
    currencyCode:'EUR',
    preferredLanguageCode:'en',
    preferredVariantCode:'standard',
  });
  assert.equal(result.printingValues[0].amount,42);
  assert.equal(result.printingValues[0].valuationKind,'fair-price');
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
  assert.equal(result.unpricedRepresentatives[0].reason, 'valuation_price_unavailable');
});

test('missing preferred language fails closed for that printing', () => {
  const canonicalCards = [card('p1-jp-standard', 'p1', 'ja', 'standard')];

  const result = buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards,
    fatePrices: [price('p1-jp-standard', 10)],
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
  });

  assert.equal(result.printingValues.length, 0);
  assert.equal(result.unpricedRepresentatives[0].reason, 'preferred_language_unavailable');
});

test('missing preferred variant fails closed instead of borrowing another finish', () => {
  const canonicalCards = [card('p1-en-reverse', 'p1', 'en', 'reverse')];

  const result = buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards,
    fatePrices: [price('p1-en-reverse', 100)],
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
  });

  assert.equal(result.printingValues.length, 0);
  assert.equal(result.unpricedRepresentatives[0].reason, 'preferred_variant_unavailable');
});

test('preferred language is required so valuation never infers language from market or user location', () => {
  assert.throws(() => buildChecklistPrintingValues({
    setId: 'set-1',
    canonicalCards: [],
    fatePrices: [],
    currencyCode: 'EUR',
  }), /preferredLanguageCode/);
});
