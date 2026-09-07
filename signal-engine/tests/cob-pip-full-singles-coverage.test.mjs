import assert from 'node:assert/strict';
import test from 'node:test';

import { COB_PIP_SINGLE_COLLECTIONS, normalizeCobPipSingleCandidate } from '../src/trader/value/cob-pip-singles-pilot.mjs';
import { runCobPipExactCardOfferCycle } from '../src/trader/value/cob-pip-exact-card-offers.mjs';
import { resolveExactRetailSingleCandidate } from '../src/trader/value/retail-single-offers.mjs';

const CHAOS_ID = 'fdset_40b2ad368841bbd285a0df18';

function cardFor(binding, overrides = {}) {
  return {
    id: 'fdcard_exact',
    fateCardId: 'fdcard_exact',
    setId: binding.canonicalSetId,
    tcgCode: 'pokemon',
    collectorNumber: '1',
    name: 'Tangela',
    variantCode: 'standard',
    languageCode: 'en',
    verificationStatus: 'verified',
    ...overrides,
  };
}

function candidateFor(binding, productTitle, variantTitle = 'Base') {
  return normalizeCobPipSingleCandidate({
    id: 100,
    title: productTitle,
    handle: 'reviewed-card',
    image: { src: 'https://cdn.example/card.jpg' },
  }, {
    id: 200,
    title: variantTitle,
    price: '0.50',
    available: true,
  }, { collection: binding, observedAt: Date.parse('2026-09-07T20:00:00.000Z') });
}

test('Cob & Pip registry covers the whole reviewed public Pokemon singles directory', () => {
  const bindings = Object.values(COB_PIP_SINGLE_COLLECTIONS);
  assert.equal(bindings.length, 24);
  assert.equal(new Set(bindings.map((item) => item.collectionHandle)).size, bindings.length);
  assert.equal(COB_PIP_SINGLE_COLLECTIONS['pokemon-pitch-black'].canonicalSetName, 'Pitch Black');
  assert.equal(COB_PIP_SINGLE_COLLECTIONS['pokemon-prismatic-evolutions'].canonicalSetName, 'Prismatic Evolutions');
  assert.equal(COB_PIP_SINGLE_COLLECTIONS['pokemon-silver-tempest'].canonicalSetId, null);
  assert.equal(COB_PIP_SINGLE_COLLECTIONS['pokemon-black-bolt'].canonicalSetId, null);
});

test('reviewed prefix grammar resolves Twilight Masquerade without fuzzy title matching', () => {
  const binding = COB_PIP_SINGLE_COLLECTIONS['pokemon-twilight-masquerade'];
  const result = resolveExactRetailSingleCandidate(
    candidateFor(binding, '#001 Twilight Masquerade Tangela'),
    { binding, canonicalCards: [cardFor(binding)] },
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.cardIdentityId, 'fdcard_exact');
  assert.equal(result.evidence.sourceCardName, 'Tangela');
});

test('reviewed suffix grammar still resolves standard Cob & Pip set titles', () => {
  const binding = COB_PIP_SINGLE_COLLECTIONS['pokemon-surging-sparks'];
  const result = resolveExactRetailSingleCandidate(
    candidateFor(binding, '#001 Exeggcute Surging Sparks'),
    { binding, canonicalCards: [cardFor(binding, { name: 'Exeggcute' })] },
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.evidence.sourceCardName, 'Exeggcute');
});

test('reviewed trailing retailer descriptors are removed only for the scoped collection', () => {
  const pending = COB_PIP_SINGLE_COLLECTIONS['pokemon-stellar-crown'];
  const binding = { ...pending, canonicalSetId: 'fdset_stellar' };
  const result = resolveExactRetailSingleCandidate(
    candidateFor(binding, '#001 Venusaur EX Stellar Crown Mint Pack Fresh', 'Standard'),
    { binding, canonicalCards: [cardFor(binding, { name: 'Venusaur EX' })] },
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.evidence.sourceCardName, 'Venusaur EX');
});

test('a catalogue-pending collection is held without blocking a ready collection', async () => {
  const state = {
    traderCatalogue: {
      tcgs: { tcg: { id: 'tcg', code: 'pokemon', name: 'Pokémon' } },
      series: { series: { id: 'series', tcgId: 'tcg', name: 'Mega Evolution', verificationStatus: 'verified' } },
      sets: { [CHAOS_ID]: { id: CHAOS_ID, tcgId: 'tcg', seriesId: 'series', name: 'Chaos Rising', verificationStatus: 'verified' } },
      printings: { weedle: { id: 'weedle', name: 'Weedle', verificationStatus: 'verified' } },
      cards: {
        weedle: {
          id: 'fdcard_weedle', tcgId: 'tcg', seriesId: 'series', setId: CHAOS_ID, printingId: 'weedle',
          collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified',
        },
      },
      setSourceMappings: {}, cardSourceMappings: {}, cardProvenance: {},
    },
  };
  const store = { async read() { return state; }, async mutate(work) { return work(state); } };
  const requested = [];
  const result = await runCobPipExactCardOfferCycle({
    store,
    collectionKeys: ['pokemon-black-bolt', 'pokemon-chaos-rising'],
    fetchImpl: async (url) => {
      requested.push(url);
      assert.match(url, /pokemon-mega-evolution-chaos-rising\/products\.json/);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            products: [{
              id: 100,
              title: '#001 Weedle Mega Evolution Chaos Rising',
              handle: '001-weedle-mega-evolution-chaos-rising',
              variants: [{ id: 200, title: 'Base', price: '0.50', available: true }],
            }],
          };
        },
      };
    },
    now: Date.parse('2026-09-07T20:00:00.000Z'),
  });

  assert.equal(requested.length, 1);
  assert.equal(result.collectionCount, 2);
  assert.equal(result.completedCollectionCount, 1);
  assert.equal(result.heldCollectionCount, 1);
  assert.equal(result.failedCollectionCount, 0);
  assert.equal(result.verified, 1);
  assert.equal(result.collections.find((item) => item.collectionKey === 'pokemon-black-bolt').reason, 'canonical_set_unavailable');
});
