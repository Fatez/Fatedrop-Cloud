import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectCobPipSinglesPilot,
  normalizeCobPipSingleCandidate,
} from '../src/trader/value/cob-pip-singles-pilot.mjs';

function product(overrides = {}) {
  return {
    id: 123,
    title: '#199 Charizard ex 199/165 Pokemon SV 151',
    handle: '199-charizard-ex-pokemon-sv-151',
    image: { src: 'https://cdn.shopify.com/card.jpg' },
    variants: [],
    ...overrides,
  };
}

function variant(overrides = {}) {
  return {
    id: 456,
    title: 'Near Mint',
    sku: 'SV151-199-NM',
    price: '44.00',
    available: true,
    ...overrides,
  };
}

test('Cob & Pip candidates remain staged even when collector evidence looks exact', () => {
  const candidate = normalizeCobPipSingleCandidate(product(), variant(), {
    observedAt: Date.parse('2026-09-07T05:50:00.000Z'),
  });

  assert.equal(candidate.retailerId, 'cob-pip');
  assert.equal(candidate.sellerType, 'retailer');
  assert.equal(candidate.retailerVariantId, '456');
  assert.equal(candidate.retailerSku, 'SV151-199-NM');
  assert.equal(candidate.pricePence, 4400);
  assert.equal(candidate.stockStatus, 'in_stock');
  assert.equal(candidate.verificationStatus, 'staged');
  assert.equal(candidate.exactIdentityVerified, false);
  assert.ok(candidate.identityHints.collectorNumbers.some((hint) => hint.cardNumber === '199' && hint.setSize === '165'));
  assert.equal(candidate.url, 'https://cobandpip.co.uk/products/199-charizard-ex-pokemon-sv-151');
});

test('Cob & Pip variants preserve stock truth and never invent quantity', () => {
  const soldOut = normalizeCobPipSingleCandidate(product(), variant({ available: false, price: '3.50' }));
  assert.equal(soldOut.stockStatus, 'out_of_stock');
  assert.equal(soldOut.stockQuantity, null);
  assert.equal(soldOut.pricePence, 350);

  const unknownPrice = normalizeCobPipSingleCandidate(product(), variant({ price: '' }));
  assert.equal(unknownPrice.pricePence, null);
});

test('Cob & Pip collector pages Shopify collection feed and returns discovery candidates only', async () => {
  const requested = [];
  const payloads = [
    { products: [product({ variants: [variant()] })] },
    { products: [] },
  ];
  let index = 0;
  const result = await collectCobPipSinglesPilot({
    pageLimit: 1,
    maxPages: 5,
    observedAt: Date.parse('2026-09-07T05:50:00.000Z'),
    fetchImpl: async (url) => {
      requested.push(url);
      const payload = payloads[index++] ?? { products: [] };
      return { ok: true, status: 200, async json() { return payload; } };
    },
  });

  assert.equal(requested.length, 2);
  assert.match(requested[0], /pokemon-single-cards\/products\.json\?limit=1&page=1$/);
  assert.match(requested[1], /pokemon-single-cards\/products\.json\?limit=1&page=2$/);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.verificationStatus, 'staged');
  assert.equal(result.exactIdentityVerified, false);
});

test('Cob & Pip collector fails closed when the retailer feed cannot be observed', async () => {
  await assert.rejects(
    collectCobPipSinglesPilot({
      fetchImpl: async () => ({ ok: false, status: 403 }),
      maxPages: 1,
    }),
    (error) => error?.status === 403 && /fetch failed/.test(error.message),
  );
});
