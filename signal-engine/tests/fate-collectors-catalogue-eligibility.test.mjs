import test from 'node:test';
import assert from 'node:assert/strict';

import { filterCollectionEligibleCardsFromStore } from '../src/trader/collection/catalogue-eligibility.mjs';

const cards = [
  { id:'valid-no-ledger', fateCardId:'valid-no-ledger' },
  { id:'active', fateCardId:'active' },
  { id:'invalid', fateCardId:'invalid' },
  { id:'unresolved', fateCardId:'unresolved' },
];

test('postgres collection eligibility excludes invalid and unresolved resolution states only', async () => {
  const queries = [];
  const store = {
    async pool() {
      return {
        async query(sql, values) {
          queries.push({ sql, values });
          return {
            rows: [
              { card_identity_id:'invalid', classifier_state:'INVALID_CATALOGUE_ENTRY' },
              { card_identity_id:'unresolved', classifier_state:'UNRESOLVED_EVIDENCE' },
            ],
          };
        },
      };
    },
  };

  const eligible = await filterCollectionEligibleCardsFromStore(store, cards);
  assert.deepEqual(eligible.map((card) => card.fateCardId), ['valid-no-ledger','active']);
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/fatedrop_variant_resolution_state/);
  assert.deepEqual(queries[0].values[0], ['valid-no-ledger','active','invalid','unresolved']);
  assert.deepEqual(queries[0].values[1], ['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE']);
});

test('file-store collections retain verified catalogue behaviour when no resolution ledger exists', async () => {
  const store = { read: async () => ({}) };
  const eligible = await filterCollectionEligibleCardsFromStore(store, cards);
  assert.equal(eligible, cards);
});
