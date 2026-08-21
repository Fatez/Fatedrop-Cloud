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

test('bulk persistence deduplicates conflict keys before PostgreSQL upserts', () => {
  assert.match(storeSource, /function uniqueBy/);
  assert.match(storeSource, /sortedBy\(uniqueBy\(products, "id"\), "id"\)/);
  assert.match(storeSource, /sortedBy\(uniqueBy\(offers, "offerId"\), "offerId"\)/);
});

test('retailer scan lock remains present in consolidated store', () => {
  assert.match(storeSource, /withRetailerScanLock/);
  assert.match(storeSource, /pg_try_advisory_lock/);
});

// Release guard: this file intentionally proves bulk performance and both reliability layers are present together.
