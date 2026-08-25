import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { syncVerifiedPokemonSet } from '../src/trader/catalogue/sync.mjs';
import { listVerifiedCardsFromStore } from '../src/trader/catalogue/store.mjs';

async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-trader-sync-'));
  return new FileStore(path.join(dir, 'store.json'));
}

const tcgdexSet = {
  id: 'svx-a',
  name: 'Example Set',
  serie: { id: 'sv', name: 'Scarlet & Violet' },
  cardCount: { official: 2, total: 2 },
  releaseDate: '2024-01-01',
  cards: [{ id: 'svx-a-1' }, { id: 'svx-a-2' }],
};
const pokemonSet = {
  id: 'svx-b',
  name: 'Example Set',
  series: 'Scarlet & Violet',
  printedTotal: 2,
  total: 2,
  releaseDate: '2024/01/01',
};
const tcgdexCards = {
  'svx-a-1': {
    id: 'svx-a-1', localId: '1', name: 'Alpha', category: 'Pokemon', rarity: 'Common',
    set: { id: 'svx-a', name: 'Example Set' },
    variants: { firstEdition: false, normal: true, reverse: true, holo: false, wPromo: false },
  },
  'svx-a-2': {
    id: 'svx-a-2', localId: '2', name: 'Beta', category: 'Pokemon', rarity: 'Rare',
    set: { id: 'svx-a', name: 'Example Set' },
    variants: { firstEdition: false, normal: false, reverse: false, holo: true, wPromo: false },
  },
};
const pokemonCards = [
  { id: 'svx-b-1', name: 'Alpha', supertype: 'Pokémon', number: '1', set: { id: 'svx-b', name: 'Example Set', series: 'Scarlet & Violet' } },
  { id: 'svx-b-2', name: 'Beta', supertype: 'Pokémon', number: '2', set: { id: 'svx-b', name: 'Example Set', series: 'Scarlet & Violet' } },
];

function clients() {
  return {
    tcgdexClient: {
      async getSet(id) { assert.equal(id, 'svx-a'); return tcgdexSet; },
      async getCard(id) { return tcgdexCards[id]; },
    },
    pokemonTcgClient: {
      async getSet(id) { assert.equal(id, 'svx-b'); return pokemonSet; },
      async listCardsBySet(id) { assert.equal(id, 'svx-b'); return pokemonCards; },
    },
  };
}

test('controlled sync can resume through one source set without duplicating canonical identities', async () => {
  const target = await store();
  const source = clients();
  const first = await syncVerifiedPokemonSet({
    store: target,
    ...source,
    tcgdexSetId: 'svx-a',
    pokemonTcgSetId: 'svx-b',
    maxCards: 1,
    verifiedAt: 1_777_000_000_000,
  });

  assert.equal(first.status, 'partial');
  assert.equal(first.processedSourceCards, 1);
  assert.equal(first.verifiedCardIdentities, 2);
  assert.equal(first.nextCursor, 'svx-a-1');

  const second = await syncVerifiedPokemonSet({
    store: target,
    ...source,
    tcgdexSetId: 'svx-a',
    pokemonTcgSetId: 'svx-b',
    cursor: first.nextCursor,
    maxCards: 1,
    verifiedAt: 1_777_000_000_001,
  });

  assert.equal(second.status, 'complete');
  assert.equal(second.verifiedCardIdentities, 1);
  assert.equal(second.nextCursor, null);

  const cards = await listVerifiedCardsFromStore(target);
  assert.equal(cards.length, 3);
  assert.deepEqual(new Set(cards.map((card) => card.name)), new Set(['Alpha', 'Beta']));
});

test('sync does not persist a set when independent set evidence conflicts', async () => {
  const target = await store();
  const source = clients();
  const result = await syncVerifiedPokemonSet({
    store: target,
    tcgdexClient: source.tcgdexClient,
    pokemonTcgClient: {
      ...source.pokemonTcgClient,
      async getSet() { return { ...pokemonSet, printedTotal: 99 }; },
    },
    tcgdexSetId: 'svx-a',
    pokemonTcgSetId: 'svx-b',
  });

  assert.equal(result.status, 'conflict');
  assert.equal(result.persisted, false);
  assert.equal((await listVerifiedCardsFromStore(target)).length, 0);
});

test('sync cursor fails closed if it does not belong to the source set', async () => {
  const target = await store();
  const source = clients();
  await assert.rejects(() => syncVerifiedPokemonSet({
    store: target,
    ...source,
    tcgdexSetId: 'svx-a',
    pokemonTcgSetId: 'svx-b',
    cursor: 'not-in-this-set',
  }), /cursor does not belong/);
});
