import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const storeSource = await readFile(new URL('../src/stores/postgres-store.mjs', import.meta.url), 'utf8');

test('Postgres scan persistence keeps bulk upserts and retry protection together', () => {
  assert.match(storeSource, /async function bulkJson/);
  assert.match(storeSource, /runTransactionWithRetry/);
  assert.match(storeSource, /pg_advisory_xact_lock/);
  assert.match(storeSource, /jsonb_array_elements\(\$1::jsonb\)/);
});

test('retailer scan lock remains present in consolidated store', () => {
  assert.match(storeSource, /withRetailerScanLock/);
  assert.match(storeSource, /pg_try_advisory_lock/);
});
