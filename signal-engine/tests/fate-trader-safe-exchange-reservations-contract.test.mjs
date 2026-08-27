import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, '../database/fate-trader-trust-safe-exchange.sql'), 'utf8');
const exchangeHttp = readFileSync(resolve(here, '../src/trader/safe-exchange/http.mjs'), 'utf8');
const collectionHttp = readFileSync(resolve(here, '../src/trader/collection/http.mjs'), 'utf8');

test('Safe Exchange migration binds agreement card state to collection truth', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION fatedrop_validate_safe_exchange_commitment_state/);
  assert.match(migration, /BEFORE INSERT ON fatedrop_safe_exchanges/);
  assert.match(migration, /committed_copy_state <> item\.copy_state/);
  assert.match(migration, /committed_condition IS DISTINCT FROM item\.condition_code/);
  assert.match(migration, /committed_grading_company IS DISTINCT FROM item\.grading_company/);
  assert.match(migration, /committed_grade IS DISTINCT FROM item\.grade_value/);
  assert.match(migration, /USING ERRCODE = 'FTR05'/);
  assert.match(exchangeHttp, /fail\(res,409,'COMMITMENT_STATE_MISMATCH'/);
});

test('Safe Exchange migration reserves active collection quantities under a row lock', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_safe_exchange_reservations/);
  assert.match(migration, /PRIMARY KEY \(exchange_id, collection_item_id\)/);
  assert.match(migration, /FOR UPDATE OF i/);
  assert.match(migration, /SUM\(r\.quantity\)/);
  assert.match(migration, /already_reserved_quantity \+ reservation\.quantity > available_trade_quantity/);
  assert.match(migration, /USING ERRCODE = 'FTR01'/);
});

test('active Safe Exchange reservations prevent collection quantities or raw condition being changed underneath an agreement', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION fatedrop_guard_reserved_collection_item_mutation/);
  assert.match(migration, /BEFORE UPDATE OF quantity, trade_quantity, status, condition_code ON fatedrop_collection_items/);
  assert.match(migration, /NEW\.trade_quantity < reserved_quantity/);
  assert.match(migration, /NEW\.quantity < reserved_quantity/);
  assert.match(migration, /NEW\.condition_code IS DISTINCT FROM OLD\.condition_code/);
  assert.match(migration, /USING ERRCODE = 'FTR03'/);
  assert.match(collectionHttp, /error\?\.code==='FTR03'/);
  assert.match(collectionHttp, /fail\(res,409,'COLLECTION_ITEM_RESERVED'/);
});

test('terminal Safe Exchanges release or consume reservations deterministically', () => {
  assert.match(migration, /AFTER UPDATE OF state ON fatedrop_safe_exchanges/);
  assert.match(migration, /NEW\.state IN \('completed', 'cancelled'\)/);
  assert.match(migration, /SET status = 'released', resolved_at = NEW\.updated_at/);
  assert.match(migration, /SET status = 'consumed', resolved_at = NEW\.updated_at/);
  assert.match(migration, /SET quantity = next_quantity,/);
  assert.match(migration, /trade_quantity = next_trade_quantity,/);
  assert.match(migration, /INSERT INTO fatedrop_collection_item_events/);
});

test('reservation and settlement conflicts are exposed as stable collector-safe 409 contracts', () => {
  assert.match(exchangeHttp, /error\?\.code==='FTR01'/);
  assert.match(exchangeHttp, /fail\(res,409,'COMMITMENT_RESERVED'/);
  assert.match(exchangeHttp, /\['FTR02','FTR04'\]\.includes\(error\?\.code\)/);
  assert.match(exchangeHttp, /fail\(res,409,'COMMITMENT_STALE'/);
});
