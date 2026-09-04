import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCardmarketNativeUniverseAudit } from '../src/trader/value/cardmarket-native-universe.mjs';

function product(id, expansionId) {
  return Object.freeze({
    sourceName: 'cardmarket',
    sourceRecordId: String(id),
    sourceExpansionId: expansionId,
  });
}

function snapshot(priceGuides, overrides = {}) {
  return Object.freeze({
    tcgCode: 'pokemon',
    sourceName: 'cardmarket',
    sourceSnapshotId: 'pokemon-price-guide-v1-2026-09-04T00:00:00.000Z',
    sourceEffectiveAt: Date.parse('2026-09-04T00:00:00.000Z'),
    currencyCode: 'EUR',
    priceGuides,
    ...overrides,
  });
}

test('Cardmarket native universe joins products to prices without canonical FateDrop mappings', () => {
  const audit = buildCardmarketNativeUniverseAudit({
    products: [
      product(1, 10),
      product(2, 10),
      product(3, 20),
    ],
    snapshot: snapshot([
      { idProduct: 1, avg: 10 },
      { idProduct: 2, 'avg-holo': 20 },
      { idProduct: 999, avg: 30 },
    ]),
  });

  assert.equal(audit.catalogueProducts, 3);
  assert.equal(audit.expansions, 2);
  assert.equal(audit.priceGuideRows, 3);
  assert.equal(audit.catalogueProductsWithPriceRow, 2);
  assert.equal(audit.catalogueProductsWithoutPriceRow, 1);
  assert.equal(audit.priceRowsWithoutCatalogueProduct, 1);
  assert.equal(audit.productPriceJoinCoveragePct, 66.67);
  assert.equal(audit.standardPricedProducts, 1);
  assert.equal(audit.standardCoveragePct, 33.33);
  assert.equal(audit.holoPricedProducts, 1);
  assert.equal(audit.holoCoveragePct, 33.33);
  assert.equal(audit.anyPricedProducts, 2);
  assert.equal(audit.anyPriceCoveragePct, 66.67);

  assert.deepEqual(audit.expansionRows, [
    {
      expansionId: '10',
      productCount: 2,
      priceRowCount: 2,
      standardPricedProducts: 1,
      holoPricedProducts: 1,
      anyPricedProducts: 2,
      standardCoveragePct: 50,
      holoCoveragePct: 50,
      anyPriceCoveragePct: 100,
    },
    {
      expansionId: '20',
      productCount: 1,
      priceRowCount: 0,
      standardPricedProducts: 0,
      holoPricedProducts: 0,
      anyPricedProducts: 0,
      standardCoveragePct: 0,
      holoCoveragePct: 0,
      anyPriceCoveragePct: 0,
    },
  ]);
});

test('Cardmarket native universe reports duplicate price rows without double counting coverage', () => {
  const audit = buildCardmarketNativeUniverseAudit({
    products: [product(1, 10)],
    snapshot: snapshot([
      { idProduct: 1, avg: 10 },
      { idProduct: 1, avg: 11 },
    ]),
  });

  assert.equal(audit.duplicatePriceRows, 1);
  assert.equal(audit.priceGuideRows, 1);
  assert.equal(audit.catalogueProductsWithPriceRow, 1);
  assert.equal(audit.standardPricedProducts, 1);
});

test('Cardmarket native universe fails closed on duplicate catalogue product ids', () => {
  assert.throws(() => buildCardmarketNativeUniverseAudit({
    products: [product(1, 10), product(1, 11)],
    snapshot: snapshot([]),
  }), /duplicate Cardmarket catalogue product id: 1/);
});

test('Cardmarket native universe rejects a non-native currency snapshot', () => {
  assert.throws(() => buildCardmarketNativeUniverseAudit({
    products: [product(1, 10)],
    snapshot: snapshot([], { currencyCode: 'GBP' }),
  }), /currency must be EUR/);
});
