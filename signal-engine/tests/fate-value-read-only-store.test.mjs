import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertFateValueReadOnlySqlForTest,
  createReadOnlyStoreView,
} from '../src/trader/value/read-only-store.mjs';

test('file rehearsal view exposes read without mutate', async () => {
  const store = {
    async read() { return { traderCatalogue: { cards: {} } }; },
    async mutate() { throw new Error('must not be exposed'); },
  };
  const view = createReadOnlyStoreView(store);

  assert.equal(typeof view.read, 'function');
  assert.equal(view.mutate, undefined);
  assert.deepEqual(await view.read(), { traderCatalogue: { cards: {} } });
});

test('Postgres rehearsal view permits SELECT but blocks INSERT before underlying pool sees it', async () => {
  const seen = [];
  const store = {
    async pool() {
      return {
        async query(sql, values) {
          seen.push({ sql, values });
          return { rows: [{ ok: true }] };
        },
      };
    },
  };
  const view = createReadOnlyStoreView(store);
  const pool = await view.pool();

  const result = await pool.query('SELECT 1 AS ok', []);
  assert.deepEqual(result.rows, [{ ok: true }]);
  await assert.rejects(pool.query('INSERT INTO nope VALUES (1)'), /blocked non-read SQL statement: INSERT/);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /^SELECT/);
});

test('read-only SQL guard ignores leading comments but rejects disguised writes', () => {
  assert.equal(assertFateValueReadOnlySqlForTest('-- diagnostic\nSELECT 1'), '-- diagnostic\nSELECT 1');
  assert.throws(
    () => assertFateValueReadOnlySqlForTest('/* rehearsal */ DELETE FROM anything'),
    /blocked non-read SQL statement: DELETE/,
  );
  assert.throws(
    () => assertFateValueReadOnlySqlForTest('WITH gone AS (DELETE FROM anything RETURNING *) SELECT * FROM gone'),
    /blocked non-read SQL statement: WITH/,
  );
});
