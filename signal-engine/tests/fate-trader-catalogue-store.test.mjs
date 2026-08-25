import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { adaptTcgdexCard, adaptTcgdexSet } from '../src/trader/catalogue/tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence, adaptPokemonTcgSet } from '../src/trader/catalogue/pokemontcg-adapter.mjs';
import { reconcileCardEvidence, reconcileSetEvidence } from '../src/trader/catalogue/reconcile.mjs';
import { promoteMatchedCardEvidence } from '../src/trader/catalogue/verification.mjs';
import { buildVerifiedCatalogueBatch } from '../src/trader/catalogue/persistence.mjs';
import {
  getVerifiedCardFromStore,
  listVerifiedCardsFromStore,
  listVerifiedCardSeriesFromStore,
  listVerifiedCardSetsFromStore,
  persistVerifiedCatalogueBatch,
} from '../src/trader/catalogue/store.mjs';

async function fileStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-trader-catalogue-'));
  return new FileStore(path.join(dir, 'store.json'));
}

function verifiedBatch(verifiedAt = 1_777_000_000_000) {
  const setMatch = reconcileSetEvidence(
    adaptTcgdexSet({
      id: 'svx-a', name: 'Example Set', serie: { id: 'sv', name: 'Scarlet & Violet' },
      cardCount: { official: 100, total: 110 }, releaseDate: '2024-01-01',
    }),
    adaptPokemonTcgSet({
      id: 'svx-b', name: 'Example Set', series: 'Scarlet & Violet', printedTotal: 100, total: 110, releaseDate: '2024/01/01',
    }),
  );
  const variant = adaptTcgdexCard({
    id: 'svx-a-1', localId: '1', name: 'Examplemon', category: 'Pokemon', rarity: 'Rare',
    set: { id: 'svx-a', name: 'Example Set' },
    variants: { firstEdition: false, normal: true, reverse: true, holo: false, wPromo: false },
  }, { sourceSeriesCode: 'sv', languageCode: 'en' });
  const corroborating = adaptPokemonTcgCardEvidence({
    id: 'svx-b-1', name: 'Examplemon', supertype: 'Pokémon', number: '1', rarity: 'Rare',
    set: { id: 'svx-b', name: 'Example Set', series: 'Scarlet & Violet' },
  });
  const cardMatch = reconcileCardEvidence(variant, corroborating, setMatch);
  const promotion = promoteMatchedCardEvidence(cardMatch, { verifiedAt });
  return buildVerifiedCatalogueBatch({ setMatch, promotions: [promotion], verifiedAt });
}

test('verified catalogue batch persists and serves series, sets and exact variants', async () => {
  const store = await fileStore();
  const batch = verifiedBatch();
  const saved = await persistVerifiedCatalogueBatch(store, batch);

  assert.deepEqual(saved, { savedSets: 1, savedPrintings: 1, savedCards: 2 });
  const series = await listVerifiedCardSeriesFromStore(store);
  const sets = await listVerifiedCardSetsFromStore(store, { seriesId: series[0].id });
  const cards = await listVerifiedCardsFromStore(store, { setId: sets[0].id });

  assert.equal(series.length, 1);
  assert.equal(sets.length, 1);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.variantCode), ['reverse-holo', 'standard'].sort());
  assert.ok(cards.every((card) => card.name === 'Examplemon'));

  const exact = await getVerifiedCardFromStore(store, cards[0].fateCardId);
  assert.equal(exact.fateCardId, cards[0].fateCardId);
  assert.equal(exact.verificationStatus, 'verified');
});

test('catalogue reads can filter by card name and variant without exposing staged data', async () => {
  const store = await fileStore();
  const batch = verifiedBatch();
  await persistVerifiedCatalogueBatch(store, batch);

  const reverse = await listVerifiedCardsFromStore(store, { query: 'example', variantCode: 'reverse-holo' });
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0].variantCode, 'reverse-holo');
});

test('source crosswalk cannot silently remap an upstream set to another canonical set', async () => {
  const store = await fileStore();
  const batch = verifiedBatch();
  await persistVerifiedCatalogueBatch(store, batch);

  const remappedSetId = 'fdset_intentional_conflict';
  const conflicting = {
    ...batch,
    set: { ...batch.set, id: remappedSetId },
    setSourceMappings: batch.setSourceMappings.map((mapping) => ({ ...mapping, setId: remappedSetId })),
  };

  await assert.rejects(() => persistVerifiedCatalogueBatch(store, conflicting), /Set source mapping conflict/);
  const sets = await listVerifiedCardSetsFromStore(store);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, batch.set.id);
});
