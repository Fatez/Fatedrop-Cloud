import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, '../database/fate-trader-safe-exchange-receiver-reconciliation.sql'), 'utf8');

test('completed Safe Exchange records an explicit ownership-transfer ledger', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_safe_exchange_transfers/);
  assert.match(migration, /PRIMARY KEY \(exchange_id, source_collection_item_id\)/);
  assert.match(migration, /UNIQUE \(received_collection_item_id\)/);
  assert.match(migration, /CHECK \(from_user_id <> to_user_id\)/);
  assert.match(migration, /INSERT INTO fatedrop_safe_exchange_transfers/);
});

test('receiver is always the opposite Safe Exchange party', () => {
  assert.match(migration, /reservation\.user_id = NEW\.party_a_user_id/);
  assert.match(migration, /receiver_user_id := NEW\.party_b_user_id/);
  assert.match(migration, /reservation\.user_id = NEW\.party_b_user_id/);
  assert.match(migration, /receiver_user_id := NEW\.party_a_user_id/);
  assert.match(migration, /reservation owner is not an exchange party/);
});

test('receiver gets exact canonical physical truth as a private non-tradeable acquisition', () => {
  assert.match(migration, /JOIN fatedrop_card_identities ci ON ci\.id = i\.card_identity_id/);
  assert.match(migration, /ci\.verification_status = 'verified'/);
  assert.match(migration, /INSERT INTO fatedrop_collections/);
  assert.match(migration, /ON CONFLICT \(user_id, tcg_id\)/);
  assert.match(migration, /INSERT INTO fatedrop_collection_items/);
  assert.match(migration, /item\.card_identity_id/);
  assert.match(migration, /item\.copy_state/);
  assert.match(migration, /item\.condition_code/);
  assert.match(migration, /reservation\.quantity,/);
  assert.match(migration, /\n      0,\n      item\.copy_state,/);
  assert.match(migration, /\n      NULL,\n      'active',/);
});

test('graded slab metadata follows the transferred physical object without copying media', () => {
  assert.match(migration, /item\.copy_state = 'graded'/);
  assert.match(migration, /INSERT INTO fatedrop_collection_grading/);
  assert.match(migration, /item\.grading_company/);
  assert.match(migration, /item\.grade_label/);
  assert.match(migration, /item\.grade_value/);
  assert.match(migration, /item\.certification_number/);
  assert.match(migration, /item\.certification_status/);
  assert.doesNotMatch(migration, /INSERT INTO fatedrop_collection_item_media/);
});

test('receiver acquisition and sender consumption are both append-only audited', () => {
  assert.match(migration, /'acquisitionMode', 'safe_exchange'/);
  assert.match(migration, /'sourceExchangeId', NEW\.id/);
  assert.match(migration, /'sourceCollectionItemId', reservation\.collection_item_id/);
  assert.match(migration, /'sourceUserId', reservation\.user_id/);
  assert.match(migration, /collection_event_type := 'removed'/);
  assert.match(migration, /collection_event_type := 'updated'/);
  assert.match(migration, /SET quantity = next_quantity,/);
  assert.match(migration, /trade_quantity = next_trade_quantity,/);
});
