import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptCardmarketCatalogue,
  adaptCardmarketCatalogueProduct,
  extractCardmarketCatalogueRows,
} from '../src/trader/value/cardmarket-catalogue-adapter.mjs';

const PRODUCT = Object.freeze({
  idProduct: 668227,
  name: 'Example Pokémon Card',
  idCategory: 51,
  categoryName: 'Pokémon Singles',
  idExpansion: 1234,
  idMetacard: 5678,
  dateAdded: '2026-06-01 12:30:00',
});

test('Cardmarket catalogue adapter retains provider evidence without inventing FateDrop identity', () => {
  const product = adaptCardmarketCatalogueProduct(PRODUCT);

  assert.equal(product.sourceName, 'cardmarket');
  assert.equal(product.sourceRecordId, '668227');
  assert.equal(product.sourceCategoryId, 51);
  assert.equal(product.sourceExpansionId, 1234);
  assert.equal(product.sourceMetacardId, 5678);
  assert.equal(product.sourceFile, 'products_singles_6.json');
  assert.equal('fateCardId' in product, false);
  assert.equal('collectorNumber' in product, false);
  assert.equal('variantCode' in product, false);
  assert.deepEqual(product.rawPayload, PRODUCT);
});

test('Cardmarket zero-date sentinel remains unknown instead of becoming a fake timestamp', () => {
  const product = adaptCardmarketCatalogueProduct({
    ...PRODUCT,
    dateAdded: '0000-00-00 00:00:00',
  });

  assert.equal(product.sourceDateAdded, null);
});

test('catalogue rows can be read from supported public-file container shapes', () => {
  assert.deepEqual(extractCardmarketCatalogueRows([PRODUCT]), [PRODUCT]);
  assert.deepEqual(extractCardmarketCatalogueRows({ products: [PRODUCT] }), [PRODUCT]);
  assert.deepEqual(extractCardmarketCatalogueRows({ data: [PRODUCT] }), [PRODUCT]);
  assert.deepEqual(extractCardmarketCatalogueRows({ items: [PRODUCT] }), [PRODUCT]);
});

test('catalogue rejects missing identity evidence rather than creating a partial crosswalk', () => {
  assert.throws(() => adaptCardmarketCatalogueProduct({
    ...PRODUCT,
    idProduct: null,
  }), /row.idProduct/);

  assert.throws(() => adaptCardmarketCatalogueProduct({
    ...PRODUCT,
    name: '',
  }), /row.name/);
});

test('catalogue rejects empty or unknown root structures', () => {
  assert.throws(() => adaptCardmarketCatalogue([]), /zero records/);
  assert.throws(() => adaptCardmarketCatalogue({ unexpected: [] }), /records array was not found/);
});
