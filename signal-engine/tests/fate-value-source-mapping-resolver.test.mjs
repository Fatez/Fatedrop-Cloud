import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVerifiedExactCardSourceMapping } from '../src/trader/value/source-mapping-resolver.mjs';

function storeWith({ verificationStatus = 'verified' } = {}) {
  const state = {
    traderCatalogue: {
      cards: {
        fdcard_verified: {
          id: 'fdcard_verified',
          verificationStatus,
        },
      },
      cardSourceMappings: {
        exact: {
          id: 'fdcardmap_exact',
          cardIdentityId: 'fdcard_verified',
          sourceName: 'cardmarket',
          sourceRecordId: '668227',
          sourceVariantKey: 'normal',
        },
      },
    },
  };
  return {
    read: async () => state,
  };
}

test('resolver returns only an exact verified mapping', async () => {
  const result = await resolveVerifiedExactCardSourceMapping(storeWith(), {
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
  });

  assert.deepEqual(result, {
    id: 'fdcardmap_exact',
    cardIdentityId: 'fdcard_verified',
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
  });
});

test('resolver does not fall back across variant keys, record ids or providers', async () => {
  const store = storeWith();

  assert.equal(await resolveVerifiedExactCardSourceMapping(store, {
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    sourceVariantKey: 'holo',
  }), null);

  assert.equal(await resolveVerifiedExactCardSourceMapping(store, {
    sourceName: 'cardmarket',
    sourceRecordId: '668228',
    sourceVariantKey: 'normal',
  }), null);

  assert.equal(await resolveVerifiedExactCardSourceMapping(store, {
    sourceName: 'tcgdex',
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
  }), null);
});

test('resolver refuses mappings to unverified card identities', async () => {
  const result = await resolveVerifiedExactCardSourceMapping(storeWith({ verificationStatus: 'staged' }), {
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
  });

  assert.equal(result, null);
});

test('resolver requires every identity dimension instead of fuzzy lookup', async () => {
  await assert.rejects(
    resolveVerifiedExactCardSourceMapping(storeWith(), {
      sourceName: 'cardmarket',
      sourceRecordId: '668227',
    }),
    /sourceVariantKey is required/,
  );
});
