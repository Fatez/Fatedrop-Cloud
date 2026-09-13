import test from 'node:test';
import assert from 'node:assert/strict';
import { retailers } from '../src/config/retailers.mjs';
import { additionalLaunchRetailers } from '../src/retailers/additional-launch-retailers.mjs';
import { shuffledReviewedCandidate, prepareShuffledActivation } from '../src/retailers/shuffled-reviewed.mjs';
import { retailerToAdapterConfig } from '../src/retailers/runtime.mjs';
import { summariseDryRun } from '../src/retailers/dry-run.mjs';

const shuffled = retailerToAdapterConfig(shuffledReviewedCandidate(), { requireMonitored: false });
const evidence = { adapterQualified: true, dryRunComplete: true, catalogueComplete: true, stockMappingValidated: true, priceCoverage: 1, productsObserved: 6, relevance: { likelyPokemonSealedCoverage: 1 } };

test('single sealed booster packs pass while individual cards and accessories remain excluded', () => {
  for (const retailer of [...retailers, ...additionalLaunchRetailers(), shuffled].filter(r => r.adapterType === 'shopify')) {
    for (const title of ['Pokemon Chaos Rising Single Booster Pack /products/pokemon-single-booster-pack', 'Pokemon Single Pack /products/pokemon-single-pack']) {
      assert.ok(retailer.include.test(title), retailer.id);
      assert.equal(retailer.exclude.test(title), false, retailer.id);
    }
    for (const title of ['Pokemon Pikachu Single Card', 'Pokemon single-card booster box', 'Pokemon PSA Graded Card', 'Pokemon Card Sleeves']) assert.ok(retailer.exclude.test(title), retailer.id);
  }
});

test('dry-run relevance agrees that a single booster pack is sealed', () => {
  const result = summariseDryRun({ retailer: shuffled, products: [{ title: 'Pokemon Single Booster Pack', pricePence: 649, stockStatus: 'in_stock' }] });
  assert.equal(result.relevance.likelyPokemonSealedCoverage, 1);
});

test('Shuffled activation uses existing readiness guards and preserves identity and delivery', () => {
  const existing = { ...shuffledReviewedCandidate(), state: 'candidate', delivery: { known: true, standardPence: 399 } };
  const next = prepareShuffledActivation(existing, evidence);
  assert.equal(next.state, 'monitored');
  assert.equal(next.id, 'shuffled');
  assert.equal(next.delivery.standardPence, 399);
  assert.equal(next.rrpAuthority, 'none');
  for (const state of ['paused', 'rejected', 'monitored']) assert.throws(() => prepareShuffledActivation({ ...existing, state }, evidence));
  assert.throws(() => prepareShuffledActivation({ ...existing, hostname: 'other.example' }, evidence));
  for (const bad of [{ catalogueComplete: false }, { stockMappingValidated: false }, { priceCoverage: 0.5 }, { productsObserved: 0 }, { relevance: { likelyPokemonSealedCoverage: 0.5 } }, { adapterQualified: false }]) assert.throws(() => prepareShuffledActivation(existing, { ...evidence, ...bad }));
});


test('JET has room for its observed eight pages without disabling completion bounds', () => {
  const jet = retailers.find(r => r.id === 'jet-cards');
  assert.equal(jet.catalogue.runtime.maxPages, 12);
  assert.equal(jet.catalogue.feedUrl, 'https://jetcards.uk/collections/pokemon-trading-cards/products.json?limit=250');
});
