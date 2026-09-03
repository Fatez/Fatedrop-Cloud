import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCollectrCsv } from '../src/trader/collection/import/collectr-csv.mjs';

test('Collectr CSV adapter parses common ownership fields and quoted commas', () => {
  const csv = `Game,Set,Name,Card Number,Rarity,Variant,Condition,Quantity,Purchase Price,Date Added\nPokémon,"Scarlet & Violet, Base",Miraidon ex,81,Double Rare,Holo,NM,2,12.50,2026-01-02\nONE PIECE CARD GAME,OP-01,Roronoa Zoro,OP01-025,SR,Normal,LP,1,,2026-02-03\nDisney Lorcana,The First Chapter,Elsa - Spirit of Winter,207,Enchanted,Foil,NM,1,150.00,2026-03-04`;
  const result = parseCollectrCsv(csv);
  assert.equal(result.rejected.length,0);
  assert.equal(result.rows.length,3);
  assert.equal(result.rows[0].tcgCode,'pokemon');
  assert.equal(result.rows[0].setName,'Scarlet & Violet, Base');
  assert.equal(result.rows[0].conditionCode,'near_mint');
  assert.equal(result.rows[0].quantity,2);
  assert.equal(result.rows[1].tcgCode,'one-piece');
  assert.equal(result.rows[2].tcgCode,'lorcana');
  assert.equal('purchasePriceText' in result.rows[0],false,'purchase-price admin is not part of Collectors V1');
  assert.equal('dateAdded' in result.rows[0],false,'source purchase dates are not part of Collectors V1');
});

test('adapter rejects rows that cannot safely identify a card', () => {
  const csv = `Game,Set,Name,Card Number,Quantity\nPokémon,Base Set,Charizard,,1\nUnknown Game,Base Set,Blastoise,2,1`;
  const result = parseCollectrCsv(csv);
  assert.equal(result.rows.length,0);
  assert.equal(result.rejected.length,2);
  assert.deepEqual(result.rejected[0].errors,['missing_card_number']);
  assert.deepEqual(result.rejected[1].errors,['unsupported_or_missing_game']);
});

test('identical duplicate rows receive deterministic distinct source keys', () => {
  const csv = `Game,Set,Name,Card Number,Quantity\nPokémon,Base Set,Charizard,4,1\nPokémon,Base Set,Charizard,4,1`;
  const first = parseCollectrCsv(csv);
  const second = parseCollectrCsv(csv);
  assert.equal(first.rows.length,2);
  assert.notEqual(first.rows[0].sourceRecordKey,first.rows[1].sourceRecordKey);
  assert.equal(first.rows[0].sourceRecordKey,second.rows[0].sourceRecordKey);
});

test('quantity and condition changes keep the same source record key for refresh reconciliation', () => {
  const before = parseCollectrCsv(`Game,Set,Name,Card Number,Variant,Condition,Quantity,Purchase Price,Date Added\nPokémon,Base Set,Charizard,4,Normal,NM,2,100,2026-01-01`);
  const after = parseCollectrCsv(`Game,Set,Name,Card Number,Variant,Condition,Quantity,Purchase Price,Date Added\nPokémon,Base Set,Charizard,4,Normal,LP,1,999,2026-08-01`);
  assert.equal(before.rows[0].sourceRecordKey,after.rows[0].sourceRecordKey);
  assert.equal(before.rows[0].quantity,2);
  assert.equal(after.rows[0].quantity,1);
  assert.equal(after.rows[0].conditionCode,'lightly_played');
});
