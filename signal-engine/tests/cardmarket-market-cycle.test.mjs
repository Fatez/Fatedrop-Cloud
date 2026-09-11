import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listVerifiedNormalCardmarketProductIds,
  listVerifiedPriceCapableCardmarketProductIds,
  scopeCardmarketPriceGuideToMappedProducts,
} from '../src/trader/value/cardmarket-market-cycle.mjs';

test('daily Cardmarket cycle scopes to verified exact normal and holo mappings without reverse substitution', async () => {
  const store = {
    async read() {
      return {
        traderCatalogue: {
          cards: {
            verified: { verificationStatus: 'verified' },
            unverified: { verificationStatus: 'staged' },
          },
          cardSourceMappings: {
            exact: {
              cardIdentityId: 'verified',
              sourceName: 'cardmarket',
              sourceRecordId: '805487',
              sourceVariantKey: 'normal',
            },
            holoLane: {
              cardIdentityId: 'verified',
              sourceName: 'cardmarket',
              sourceRecordId: '805488',
              sourceVariantKey: 'holo',
            },
            reverseLane: {
              cardIdentityId: 'verified',
              sourceName: 'cardmarket',
              sourceRecordId: '805489',
              sourceVariantKey: 'reverse',
            },
            staged: {
              cardIdentityId: 'unverified',
              sourceName: 'cardmarket',
              sourceRecordId: '999999',
              sourceVariantKey: 'normal',
            },
            otherSource: {
              cardIdentityId: 'verified',
              sourceName: 'tcgdex',
              sourceRecordId: 'sv08.5-093',
              sourceVariantKey: 'normal',
            },
          },
        },
      };
    },
  };

  const productIds = await listVerifiedNormalCardmarketProductIds(store);
  assert.deepEqual([...productIds], ['805487']);

  const priceCapable = await listVerifiedPriceCapableCardmarketProductIds(store);
  assert.deepEqual([...priceCapable].sort(), ['805487', '805488']);

  const payload = {
    version: 1,
    createdAt: '2026-09-05T00:00:00+0000',
    priceGuides: [
      { idProduct: 805487, trend: 1.5 },
      { idProduct: 805488, 'trend-holo': 4.5 },
      { idProduct: 805489, trend: 8.5 },
      { idProduct: 999999, trend: 9.9 },
    ],
  };
  const scoped = scopeCardmarketPriceGuideToMappedProducts(payload, priceCapable);

  assert.equal(scoped.version, payload.version);
  assert.equal(scoped.createdAt, payload.createdAt);
  assert.deepEqual(scoped.priceGuides, [
    { idProduct: 805487, trend: 1.5 },
    { idProduct: 805488, 'trend-holo': 4.5 },
  ]);
  assert.equal(payload.priceGuides.length, 4);
});
