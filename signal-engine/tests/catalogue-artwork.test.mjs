import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseArtworkUrl, selectChecklistArtworkEvidence } from '../src/trader/catalogue/artwork.mjs';
import { adaptTcgdexCard } from '../src/trader/catalogue/tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence } from '../src/trader/catalogue/pokemontcg-adapter.mjs';
import { buildVerifiedCatalogueBatch } from '../src/trader/catalogue/persistence.mjs';
import { enrichPrintingsWithArtwork, getPrintingArtworkCoverageFromStore, persistVerifiedPrintingArtwork } from '../src/trader/catalogue/artwork-store.mjs';

const tcgdexImage = 'https://assets.tcgdex.net/en/base/base1/1';
const tcgdexThumbnail = 'https://assets.tcgdex.net/en/base/base1/1/low.webp';
const pokemonImage = 'https://images.pokemontcg.io/base1/1.png';

test('artwork URLs are HTTPS-only and exact source evidence prefers the first usable image', () => {
  assert.equal(normaliseArtworkUrl(tcgdexImage), tcgdexImage);
  assert.equal(normaliseArtworkUrl('http://example.com/card.png'), null);
  assert.equal(normaliseArtworkUrl('javascript:alert(1)'), null);
  const selected = selectChecklistArtworkEvidence(
    { sourceName: 'tcgdex', sourceRecordId: 'base1-1', thumbnailUrl: tcgdexImage, sourceUrl: 'https://api.tcgdex.net/v2/en/cards/base1-1' },
    { sourceName: 'pokemontcg-api', sourceRecordId: 'base1-1', thumbnailUrl: pokemonImage },
  );
  assert.equal(selected.thumbnailUrl, tcgdexImage);
  assert.equal(selected.sourceName, 'tcgdex');
});

test('Pokemon source adapters retain artwork evidence without changing card identity', () => {
  const tcgdex = adaptTcgdexCard({
    id: 'base1-1', localId: '1', name: 'Alakazam', image: tcgdexImage, rarity: 'Rare', category: 'Pokemon',
    set: { id: 'base1', name: 'Base Set' },
    variants: { normal: false, reverse: false, holo: true, firstEdition: false },
  }, { sourceSeriesCode: 'base', languageCode: 'en' });
  assert.equal(tcgdex.baseEvidence.thumbnailUrl, tcgdexThumbnail);
  assert.equal(tcgdex.baseEvidence.collectorNumber, '1');

  const pokemon = adaptPokemonTcgCardEvidence({
    id: 'base1-1', name: 'Alakazam', number: '1', supertype: 'Pokémon', rarity: 'Rare Holo',
    images: { small: pokemonImage, large: 'https://images.pokemontcg.io/base1/1_hires.png' },
    set: { id: 'base1', name: 'Base', series: 'Base' },
  });
  assert.equal(pokemon.thumbnailUrl, pokemonImage);
  assert.equal(pokemon.collectorNumber, '1');
});

test('verified printing batches persist artwork as non-identity metadata', () => {
  const batch = buildVerifiedCatalogueBatch({
    verifiedAt: 1_700_000_000_000,
    setMatch: {
      status: 'matched', tcgCode: 'pokemon', canonicalSeriesId: 'series-1', canonicalSetId: 'set-1',
      seriesName: 'Base', setName: 'Base Set', printedTotal: 102, total: 102, releasedAt: 915148800000,
      evidence: [],
    },
    checklistPrintings: [{
      status: 'matched', tcgCode: 'pokemon', seriesCode: 'series-1', setCode: 'set-1', collectorNumber: '1', printingCode: 'main',
      name: 'Alakazam', rarity: 'Rare Holo', supertype: 'Pokémon', subtypes: [], nationalDexNumbers: [65],
      thumbnailUrl: tcgdexImage,
      artworkEvidence: { thumbnailUrl: tcgdexImage, sourceName: 'tcgdex', sourceRecordId: 'base1-1', sourceUrl: 'https://api.tcgdex.net/v2/en/cards/base1-1' },
      verificationBasis: { kind: 'base_printing_cross_source' },
    }],
  });
  assert.equal(batch.printings.length, 1);
  assert.equal(batch.printings[0].attributes.artwork.thumbnailUrl, tcgdexImage);
  assert.equal(batch.printings[0].collectorNumber, '1');
});

test('artwork persistence backfills existing printings and can be audited independently', async () => {
  const state = {
    traderCatalogue: {
      printings: {
        p1: { id: 'p1', verificationStatus: 'verified', attributes: {}, updatedAt: 1 },
        p2: { id: 'p2', verificationStatus: 'verified', attributes: {}, updatedAt: 1 },
      },
    },
  };
  const store = {
    async read() { return state; },
    async mutate(mutator) { return mutator(state); },
  };
  await persistVerifiedPrintingArtwork(store, [{
    id: 'p1',
    attributes: { artwork: { thumbnailUrl: tcgdexImage, sourceName: 'tcgdex', sourceRecordId: 'base1-1' } },
  }], { observedAt: 5 });
  const coverage = await getPrintingArtworkCoverageFromStore(store);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.withThumbnail, 1);
  assert.deepEqual(coverage.missing, ['p2']);
  const enriched = await enrichPrintingsWithArtwork(store, [{ id: 'p1', printingId: 'p1' }, { id: 'p2', printingId: 'p2' }]);
  assert.equal(enriched[0].thumbnailUrl, tcgdexImage);
  assert.equal(enriched[1].thumbnailUrl, null);
});
