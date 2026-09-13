import test from 'node:test';
import assert from 'node:assert/strict';
import { assessResolutionAwareRootCandidate } from '../src/trader/value/cardmarket-resolution-aware-root-recovery-cli.mjs';

const identity = Object.freeze({
  cardIdentityId: 'fdcard_test',
  variantCode: 'standard',
  name: 'Vespiquen',
  collectorNumber: '10',
});
const card = Object.freeze({ name: 'Vespiquen', localId: '010' });
const set = Object.freeze({ cardmarketExpansionId: 77 });
const product = Object.freeze({ sourceExpansionId: 77, name: 'Vespiquen' });

test('accepts exact card crosswalk with matching set, product and standard price lane', () => {
  const result = assessResolutionAwareRootCandidate({ identity, tcgdexCard: card, tcgdexSet: set, product, priceRow: { trend: 1.2 }, sourceOwner: null });
  assert.equal(result.status, 'SAFE_MAPPING_CANDIDATE');
  assert.equal(result.sourceVariantKey, 'normal');
  assert.equal(result.priceLane, 'standard');
});

test('locked holo identity requires the Cardmarket holo lane', () => {
  const holo = { ...identity, variantCode: 'holo' };
  assert.equal(assessResolutionAwareRootCandidate({ identity: holo, tcgdexCard: card, tcgdexSet: set, product, priceRow: { trend: 1.2 }, sourceOwner: null }).status, 'HOLD_PRICE_LANE_MISSING');
  const result = assessResolutionAwareRootCandidate({ identity: holo, tcgdexCard: card, tcgdexSet: set, product, priceRow: { 'trend-holo': 2.4 }, sourceOwner: null });
  assert.equal(result.status, 'SAFE_MAPPING_CANDIDATE');
  assert.equal(result.sourceVariantKey, 'holo');
});

test('fails closed on collector mismatch', () => {
  const result = assessResolutionAwareRootCandidate({ identity, tcgdexCard: { ...card, localId: '11' }, tcgdexSet: set, product, priceRow: { trend: 1.2 }, sourceOwner: null });
  assert.equal(result.status, 'HOLD_TCGDEX_COLLECTOR_MISMATCH');
});

test('fails closed on Cardmarket expansion mismatch', () => {
  const result = assessResolutionAwareRootCandidate({ identity, tcgdexCard: card, tcgdexSet: set, product: { ...product, sourceExpansionId: 78 }, priceRow: { trend: 1.2 }, sourceOwner: null });
  assert.equal(result.status, 'HOLD_EXPANSION_MISMATCH');
});

test('fails closed when the product lane is already owned by another identity', () => {
  const result = assessResolutionAwareRootCandidate({ identity, tcgdexCard: card, tcgdexSet: set, product, priceRow: { trend: 1.2 }, sourceOwner: 'fdcard_other' });
  assert.equal(result.status, 'HOLD_PRODUCT_ALREADY_OWNED');
});

test('does not reinterpret Cardmarket base pricing as holo pricing', () => {
  const result = assessResolutionAwareRootCandidate({ identity: { ...identity, variantCode: 'holo' }, tcgdexCard: card, tcgdexSet: set, product, priceRow: { low: 0.2, trend: 0.3, avg: 0.4 }, sourceOwner: null });
  assert.equal(result.status, 'HOLD_PRICE_LANE_MISSING');
});
