import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enrichCardsWithArtworkFromStore,
  getVerifiedPrintingArtworkFromStore,
} from '../src/trader/catalogue/artwork-read.mjs';

const card = { id: 'card-1', printingId: 'printing-1', name: 'Bulbasaur' };

test('file catalogue cards expose only persisted HTTPS printing artwork', async () => {
  const store = {
    async read() {
      return {
        traderCatalogue: {
          printings: {
            'printing-1': {
              attributes: { artwork: { thumbnailUrl: 'https://assets.tcgdex.net/en/base/base1/044/low.webp' } },
            },
          },
        },
      };
    },
  };

  const [result] = await enrichCardsWithArtworkFromStore(store, [card]);
  assert.equal(result.thumbnailUrl, 'https://assets.tcgdex.net/en/base/base1/044/low.webp');
  assert.equal(result.id, card.id);
});

test('unsafe persisted artwork fails closed instead of becoming a public thumbnail', async () => {
  const store = {
    async read() {
      return {
        traderCatalogue: {
          printings: {
            'printing-1': {
              attributes: { artwork: { thumbnailUrl: 'http://example.test/bulbasaur.png' } },
            },
          },
        },
      };
    },
  };

  const result = await enrichCardsWithArtworkFromStore(store, card);
  assert.equal(result.thumbnailUrl, null);
});

test('postgres catalogue artwork lookup is batched by exact verified printing ids', async () => {
  let queryText = '';
  let queryParams = null;
  const store = {
    async pool() {
      return {
        async query(text, params) {
          queryText = text;
          queryParams = params;
          return {
            rows: [{
              id: 'printing-1',
              thumbnail_url: 'https://images.pokemontcg.io/base1/44.png',
            }],
          };
        },
      };
    },
  };

  const [result] = await enrichCardsWithArtworkFromStore(store, [card]);
  assert.match(queryText, /verification_status='verified'/);
  assert.deepEqual(queryParams, [['printing-1']]);
  assert.equal(result.thumbnailUrl, 'https://images.pokemontcg.io/base1/44.png');
});

test('exact artwork route lookup requires one verified set and collector printing', async () => {
  let queryText = '';
  let queryParams = null;
  const store = {
    async pool() {
      return {
        async query(text, params) {
          queryText = text;
          queryParams = params;
          return { rows: [{ thumbnail_url: 'https://assets.tcgdex.net/en/swsh/swsh10/001/low.webp' }] };
        },
      };
    },
  };

  const result = await getVerifiedPrintingArtworkFromStore(store, {
    setId: 'fdset-example',
    collectorNumber: '1',
  });
  assert.match(queryText, /verification_status='verified'/);
  assert.match(queryText, /set_id=\$1/);
  assert.match(queryText, /collector_number=\$2/);
  assert.deepEqual(queryParams, ['fdset-example', '1']);
  assert.equal(result, 'https://assets.tcgdex.net/en/swsh/swsh10/001/low.webp');
});

test('exact artwork lookup fails closed when canonical printing is not unique', async () => {
  const store = {
    async pool() {
      return {
        async query() {
          return {
            rows: [
              { thumbnail_url: 'https://assets.tcgdex.net/en/swsh/swsh10/001/low.webp' },
              { thumbnail_url: 'https://assets.tcgdex.net/en/swsh/swsh10/001/high.webp' },
            ],
          };
        },
      };
    },
  };

  assert.equal(await getVerifiedPrintingArtworkFromStore(store, { setId: 'set', collectorNumber: '1' }), null);
});
