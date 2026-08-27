import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, '../database/fate-trader-trust-safe-exchange.sql'), 'utf8');
const http = readFileSync(resolve(here, '../src/trader/safe-exchange/http.mjs'), 'utf8');

test('Safe Exchange migration reserves active collection quantities under a row lock', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_safe_exchange_reservations/);
  assert.match(migration, /PRIMARY KEY \(exchange_id, collection_item_id\)/);
  assert.match(migration, /FOR UPDATE OF i/);
  assert.match(migration, /SUM\(r\.quantity\)/);
  assert.match(migration, /already_reserved_quantity \+ reservation\.quantity > available_trade_quantity/);
  assert.match(migration, /USING ERRCODE = 'FTR01'/);
});

test('Safe Exchange reservations are released only when an exchange becomes terminal', () => {
  assert.match(migration, /AFTER UPDATE OF state ON fatedrop_safe_exchanges/);
  assert.match(migration, /NEW\.state IN \('completed', 'cancelled'\)/);
  assert.match(migration, /SET status = 'released', released_at = NEW\.updated_at/);
});

test('reservation conflicts are exposed as a stable collector-safe 409 contract', () => {
  assert.match(http, /error\?\.code==='FTR01'/);
  assert.match(http, /fail\(res,409,'COMMITMENT_RESERVED'/);
  assert.match(http, /error\?\.code==='FTR02'/);
  assert.match(http, /fail\(res,409,'COMMITMENT_STALE'/);
});
