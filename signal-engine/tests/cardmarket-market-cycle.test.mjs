import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listVerifiedNormalCardmarketProductIds,
  scopeCardmarketPriceGuideToMappedProducts,
} from '../src/trader/value/cardmarket-market-cycle.mjs';

test('daily Cardmarket cycle scopes to verified exact normal mappings only', async () => {
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
              sourceRecordId: '805487',
              sourceVariantKey: 'holo',
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

  const payload = {
    version: 1,
    createdAt: '2026-09-05T00:00:00+0000',
    priceGuides: [
      { idProduct: 805487, trend: 1.5 },
      { idProduct: 999999, trend: 9.9 },
    ],
  };
  const scoped = scopeCardmarketPriceGuideToMappedProducts(payload, productIds);

  assert.equal(scoped.version, payload.version);
  assert.equal(scoped.createdAt, payload.createdAt);
  assert.deepEqual(scoped.priceGuides, [{ idProduct: 805487, trend: 1.5 }]);
  assert.equal(payload.priceGuides.length, 2);
});
