import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredProductIndex,
  resolveStructuredIdentity,
} from '../src/trader/value/cardmarket-structured-identity-recovery-cli.mjs';

function product(id, expansion, name) {
  return {
    sourceName: 'cardmarket',
    sourceRecordId: String(id),
    sourceExpansionId: expansion,
    sourceMetacardId: id + 1000,
    name,
  };
}

function identity(overrides = {}) {
  return {
    cardIdentityId: 'fdcard_test',
    setId: 'set_test',
    setName: 'Ancient Origins',
    name: 'Vespiquen',
    collectorNumber: '10',
    variantCode: 'standard',
    cardmarketExpansionIds: ['77'],
    ...overrides,
  };
}

test('resolves one exact structured product with the target standard lane', () => {
  const products = [product(284211, 77, 'Vespiquen (AOR 10)')];
  const result = resolveStructuredIdentity(identity(), {
    productIndex: buildStructuredProductIndex(products),
    priceByProduct: new Map([['284211', { trend: 1.25 }]]),
    sourceOwners: new Map(),
  });
  assert.equal(result.status, 'SAFE_MAPPING_CANDIDATE');
  assert.equal(result.candidate.sourceRecordId, '284211');
  assert.equal(result.candidate.sourceVariantKey, 'normal');
  assert.equal(result.candidate.priceLane, 'standard');
});

test('accepts only a terminal Cardmarket V-number artwork suffix as a name-equivalent hint', () => {
  const products = [product(284211, 77, 'Vespiquen V1 (AOR 10)')];
  const result = resolveStructuredIdentity(identity(), {
    productIndex: buildStructuredProductIndex(products),
    priceByProduct: new Map([['284211', { trend: 1.25 }]]),
    sourceOwners: new Map(),
  });
  assert.equal(result.status, 'SAFE_MAPPING_CANDIDATE');
  assert.equal(result.candidate.nameMatchBasis, 'provider_artwork_version_suffix');
});

test('holds multiple exact products instead of selecting the first result', () => {
  const products = [
    product(284211, 77, 'Vespiquen V1 (AOR 10)'),
    product(284212, 77, 'Vespiquen V2 (AOR 10)'),
  ];
  const result = resolveStructuredIdentity(identity(), {
    productIndex: buildStructuredProductIndex(products),
    priceByProduct: new Map([
      ['284211', { trend: 1.25 }],
      ['284212', { trend: 1.30 }],
    ]),
    sourceOwners: new Map(),
  });
  assert.equal(result.status, 'HOLD_MULTIPLE_PRODUCTS');
  assert.equal(result.candidates.length, 2);
});

test('requires the target holo price lane for a holo identity', () => {
  const products = [product(400001, 88, 'Arceus LV.X (AR 94)')];
  const result = resolveStructuredIdentity(identity({
    name: 'Arceus LV.X',
    collectorNumber: '94',
    variantCode: 'holo',
    cardmarketExpansionIds: ['88'],
  }), {
    productIndex: buildStructuredProductIndex(products),
    priceByProduct: new Map([['400001', { trend: 40 }]]),
    sourceOwners: new Map(),
  });
  assert.equal(result.status, 'HOLD_PRICE_LANE_MISSING');
});

test('accepts a meaningful holo lane for a holo identity', () => {
  const products = [product(400001, 88, 'Arceus LV.X (AR 94)')];
  const result = resolveStructuredIdentity(identity({
    name: 'Arceus LV.X',
    collectorNumber: '94',
    variantCode: 'holo',
    cardmarketExpansionIds: ['88'],
  }), {
    productIndex: buildStructuredProductIndex(products),
    priceByProduct: new Map([['400001', { 'trend-holo': 40 }]]),
    sourceOwners: new Map(),
  });
  assert.equal(result.status, 'SAFE_MAPPING_CANDIDATE');
  assert.equal(result.candidate.sourceVariantKey, 'holo');
});

test('holds a product+finish lane already owned by another canonical identity', () => {
  const products = [product(284211, 77, 'Vespiquen (AOR 10)')];
  const result = resolveStructuredIdentity(identity(), {
    productIndex: buildStructuredProductIndex(products),
    priceByProduct: new Map([['284211', { trend: 1.25 }]]),
    sourceOwners: new Map([['284211|normal', 'fdcard_other']]),
  });
  assert.equal(result.status, 'HOLD_PRODUCT_ALREADY_OWNED');
});

test('holds identities whose set lacks an exact Cardmarket expansion mapping', () => {
  const result = resolveStructuredIdentity(identity({ cardmarketExpansionIds: [] }), {
    productIndex: new Map(),
    priceByProduct: new Map(),
    sourceOwners: new Map(),
  });
  assert.equal(result.status, 'HOLD_SET_MAPPING_MISSING');
});
