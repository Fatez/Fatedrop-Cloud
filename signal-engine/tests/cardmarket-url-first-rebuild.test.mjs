import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCardmarketProductIndexes,
  cardmarketCardSlug,
  cardmarketSetSlug,
  chooseDominantExpansion,
  resolveCardmarketProduct,
  reviewedCardmarketUrl,
} from '../src/trader/value/cardmarket-url-first-rebuild.mjs';

const overrides = {
  'Crystal Guardians': 'EX-Crystal-Guardians',
  'EX trainer Kit 2 (Plusle)': 'EX-Trainer-Kit-2-Plusle',
};

test('reconstructs reviewed Cardmarket URLs from canonical identity fields', () => {
  assert.equal(
    reviewedCardmarketUrl({ setName: 'Ancient Origins', name: 'Vespiquen', collectorNumber: '10' }, overrides),
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/Ancient-Origins/Vespiquen-10',
  );
  assert.equal(
    reviewedCardmarketUrl({ setName: 'Crystal Guardians', name: 'Nidoran♀ δ', collectorNumber: '56' }, overrides),
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/EX-Crystal-Guardians/Nidoran-F-56',
  );
  assert.equal(
    reviewedCardmarketUrl({ setName: 'Arceus', name: 'Arceus LV.X', collectorNumber: '94' }, overrides),
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/Arceus/Arceus-LVX-94',
  );
  assert.equal(
    reviewedCardmarketUrl({ setName: 'EX trainer Kit 2 (Plusle)', name: "Professor Cozmo's Discovery", collectorNumber: '10' }, overrides),
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/EX-Trainer-Kit-2-Plusle/Professor-Cozmos-Discovery-10',
  );
  assert.equal(cardmarketCardSlug('Pokégear 3.0', '96'), 'Pokegear-30-96');
  assert.equal(cardmarketSetSlug('Black & White', overrides), 'Black-White');
});

test('dominant expansion rejects weak or tied evidence', () => {
  assert.deepEqual(chooseDominantExpansion(new Map([['10', 9], ['11', 1]])), {
    expansionId: '10', anchors: 9, total: 10, share: 0.9, secondCount: 1,
  });
  assert.equal(chooseDominantExpansion(new Map([['10', 2], ['11', 2]])), null);
  assert.deepEqual(chooseDominantExpansion(new Map([['10', 1]])), {
    expansionId: '10', anchors: 1, total: 1, share: 1, secondCount: 0,
  });
});

test('prefers exact structured name and collector inside the selected expansion', () => {
  const products = [
    { sourceRecordId: '100', sourceExpansionId: 9, name: 'Vespiquen (AOR 010)' },
    { sourceRecordId: '101', sourceExpansionId: 9, name: 'Vespiquen (AOR 011)' },
  ];
  const indexes = buildCardmarketProductIndexes(products);
  const priceById = new Map([['100', { idProduct: 100, trend: 0.3 }]]);
  const result = resolveCardmarketProduct({ name: 'Vespiquen', collector_number: '10', collectorNumber: '10', variant_code: 'standard' }, '9', indexes, priceById);
  assert.equal(result.status, 'resolved');
  assert.equal(result.sourceRecordId, '100');
  assert.equal(result.method, 'structured_name_collector');
  assert.equal(result.priceEvidence.standard, true);
});

test('uses a unique provider root name inside a proven expansion but fails closed on duplicates', () => {
  const unique = buildCardmarketProductIndexes([
    { sourceRecordId: '200', sourceExpansionId: 20, name: 'Torchic [Ember | ADV]' },
  ]);
  const resolved = resolveCardmarketProduct({ name: 'Torchic', collectorNumber: '17', variant_code: 'standard' }, '20', unique, new Map());
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.sourceRecordId, '200');
  assert.equal(resolved.method, 'unique_root_name_inside_expansion');

  const ambiguous = buildCardmarketProductIndexes([
    { sourceRecordId: '300', sourceExpansionId: 30, name: 'Pikachu [Thunder Wave | Electro Ball]' },
    { sourceRecordId: '301', sourceExpansionId: 30, name: 'Pikachu [Thunder Wave | Electro Ball]' },
  ]);
  const held = resolveCardmarketProduct({ name: 'Pikachu', collectorNumber: 'sm81', variant_code: 'standard' }, '30', ambiguous, new Map());
  assert.equal(held.status, 'ambiguous');
  assert.equal(held.candidates.length, 2);
});
