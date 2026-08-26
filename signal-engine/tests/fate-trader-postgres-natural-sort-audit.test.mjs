import assert from 'node:assert/strict';
import test from 'node:test';
import { listVerifiedCardsFromStore } from '../src/trader/catalogue/store.mjs';

test('Postgres Trader card browse orders numeric collector numbers naturally before alphanumeric numbers', async () => {
  let sql = '';
  const store = {
    async pool() {
      return {
        async query(statement) {
          sql = statement;
          return { rows: [] };
        },
      };
    },
  };

  await listVerifiedCardsFromStore(store, { setId: 'fdset_test', limit: 500 });

  assert.match(sql, /CASE WHEN c\.collector_number ~ '\^\[0-9\]\+\$' THEN 0 ELSE 1 END/);
  assert.match(sql, /c\.collector_number::numeric/);
  assert.match(sql, /LOWER\(c\.collector_number\)/);
  assert.match(sql, /c\.variant_code/);
  assert.ok(sql.indexOf('c.collector_number::numeric') < sql.indexOf('LOWER(c.collector_number)'));
});
