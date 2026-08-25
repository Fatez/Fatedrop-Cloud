import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { buildVerifiedPokemonSetCrosswalk, syncVerifiedPokemonCatalogue } from '../src/trader/catalogue/bulk-sync.mjs';
import { listVerifiedCardsFromStore } from '../src/trader/catalogue/store.mjs';

async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-trader-bulk-sync-'));
  return new FileStore(path.join(dir, 'store.json'));
}

function tcgdexSet(id, name, series, releaseDate, number, cardName = 'Alpha') {
  return {
    id,
    name,
    serie: { id: series.toLowerCase().replaceAll(' ', '-'), name: series },
    cardCount: { official: 1, total: 1 },
    releaseDate,
    cards: [{ id: `${id}-${number}` }],
    card: {
      id: `${id}-${number}`,
      localId: String(number),
      name: cardName,
      category: 'Pokemon',
      rarity: 'Common',
      set: { id, name },
      variants: { firstEdition: false, normal: true, reverse: false, holo: false, wPromo: false },
    },
  };
}

function pokemonSet(id, name, series, releaseDate, number, cardName = 'Alpha') {
  return {
    id,
    name,
    series,
    printedTotal: 1,
    total: 1,
    releaseDate: releaseDate.replaceAll('-', '/'),
    card: {
      id: `${id}-${number}`,
      name: cardName,
      supertype: 'Pokémon',
      number: String(number),
      set: { id, name, series },
    },
  };
}

function catalogueClients({ tcgdexSets, pokemonSets, failCardId = null }) {
  const td = new Map(tcgdexSets.map((set) => [set.id, set]));
  const pk = new Map(pokemonSets.map((set) => [set.id, set]));
  return {
    tcgdexClient: {
      async listSets() { return tcgdexSets.map(({ id, name }) => ({ id, name })); },
      async getSet(id) { return td.get(id); },
      async getCard(id) {
        if (id === failCardId) throw new Error('simulated source failure');
        const owner = tcgdexSets.find((set) => set.card.id === id);
        return owner?.card;
      },
    },
    pokemonTcgClient: {
      async listSets() { return pokemonSets.map(({ card, ...set }) => set); },
      async getSet(id) { return pk.get(id); },
      async listCardsBySet(id) { return [pk.get(id).card]; },
    },
  };
}

test('crosswalk accepts only independently reconciled English set pairs and reports gaps', async () => {
  const tdA = tcgdexSet('td-a', 'First Set', 'Base', '1999-01-09', 1);
  const tdB = tcgdexSet('td-b', 'Missing Set', 'Base', '2000-01-01', 1);
  const pkA = pokemonSet('pk-a', 'First Set', 'Base', '1999-01-09', 1);
  const pkExtra = pokemonSet('pk-extra', 'API Only Set', 'Base', '2001-01-01', 1);
  const source = catalogueClients({ tcgdexSets: [tdA, tdB], pokemonSets: [pkA, pkExtra] });

  const plan = await buildVerifiedPokemonSetCrosswalk(source);
  assert.equal(plan.counts.matched, 1);
  assert.equal(plan.matched[0].tcgdexSetId, 'td-a');
  assert.equal(plan.matched[0].pokemonTcgSetId, 'pk-a');
  assert.deepEqual(plan.unmatchedTcgdex.map((row) => row.tcgdexSetId), ['td-b']);
  assert.ok(plan.unmatchedPokemon.some((row) => row.pokemonTcgSetId === 'pk-extra'));
});

test('crosswalk never guesses when duplicate source names produce more than one verified candidate', async () => {
  const td = tcgdexSet('td-a', 'Promo Set', 'Promo', '2020-01-01', 1);
  const pkA = pokemonSet('pk-a', 'Promo Set', 'Promo', '2020-01-01', 1);
  const pkB = pokemonSet('pk-b', 'Promo Set', 'Promo', '2020-01-01', 1);
  const plan = await buildVerifiedPokemonSetCrosswalk(catalogueClients({ tcgdexSets: [td], pokemonSets: [pkA, pkB] }));

  assert.equal(plan.counts.matched, 0);
  assert.equal(plan.counts.ambiguous, 1);
  assert.equal(plan.ambiguous[0].candidates.length, 2);
  assert.ok(plan.ambiguous[0].candidates.every((candidate) => candidate.status === 'matched'));
});

test('crosswalk quarantines a same-name candidate when independent set totals conflict', async () => {
  const td = tcgdexSet('td-a', 'Conflict Set', 'Series X', '2022-01-01', 1);
  const pk = pokemonSet('pk-a', 'Conflict Set', 'Series X', '2022-01-01', 1);
  pk.printedTotal = 99;
  const plan = await buildVerifiedPokemonSetCrosswalk(catalogueClients({ tcgdexSets: [td], pokemonSets: [pk] }));

  assert.equal(plan.counts.matched, 0);
  assert.equal(plan.counts.rejected, 1);
  assert.equal(plan.rejected[0].status, 'conflict');
  assert.equal(plan.rejected[0].field, 'printedTotal');
});

test('whole-catalogue sync is bounded, resumable by verified set and idempotent across runs', async () => {
  const tdA = tcgdexSet('td-a', 'First Set', 'Series A', '2020-01-01', 1, 'Alpha');
  const tdB = tcgdexSet('td-b', 'Second Set', 'Series B', '2021-01-01', 2, 'Beta');
  const pkA = pokemonSet('pk-a', 'First Set', 'Series A', '2020-01-01', 1, 'Alpha');
  const pkB = pokemonSet('pk-b', 'Second Set', 'Series B', '2021-01-01', 2, 'Beta');
  const source = catalogueClients({ tcgdexSets: [tdB, tdA], pokemonSets: [pkB, pkA] });
  const target = await store();
  const plan = await buildVerifiedPokemonSetCrosswalk(source);

  assert.deepEqual(plan.matched.map((row) => row.tcgdexSetId), ['td-a', 'td-b']);
  const first = await syncVerifiedPokemonCatalogue({
    store: target,
    ...source,
    crosswalk: plan,
    maxSets: 1,
    maxCardsPerChunk: 1,
    verifiedAt: 1_777_000_000_000,
  });
  assert.equal(first.status, 'partial');
  assert.equal(first.totals.setsCompleted, 1);
  assert.equal(first.nextSetCursor, 'td-a');

  const second = await syncVerifiedPokemonCatalogue({
    store: target,
    ...source,
    crosswalk: plan,
    startAfterSetId: first.nextSetCursor,
    maxSets: 1,
    maxCardsPerChunk: 1,
    verifiedAt: 1_777_000_000_001,
  });
  assert.equal(second.status, 'complete');
  assert.equal(second.totals.setsCompleted, 1);

  const repeat = await syncVerifiedPokemonCatalogue({
    store: target,
    ...source,
    crosswalk: plan,
    maxSets: 2,
    maxCardsPerChunk: 1,
    verifiedAt: 1_777_000_000_002,
  });
  assert.equal(repeat.status, 'complete');

  const cards = await listVerifiedCardsFromStore(target, { limit: 50 });
  assert.equal(cards.length, 2);
  assert.deepEqual(new Set(cards.map((card) => card.name)), new Set(['Alpha', 'Beta']));
  assert.ok(cards.every((card) => card.fateCardId.startsWith('fdcard_')));
  assert.ok(cards.every((card) => !card.fateCardId.includes('td-') && !card.fateCardId.includes('pk-')));
});

test('whole-catalogue sync exposes a safe set-boundary restart cursor after source failure', async () => {
  const tdA = tcgdexSet('td-a', 'First Set', 'Series A', '2020-01-01', 1, 'Alpha');
  const tdB = tcgdexSet('td-b', 'Second Set', 'Series B', '2021-01-01', 2, 'Beta');
  const pkA = pokemonSet('pk-a', 'First Set', 'Series A', '2020-01-01', 1, 'Alpha');
  const pkB = pokemonSet('pk-b', 'Second Set', 'Series B', '2021-01-01', 2, 'Beta');
  const source = catalogueClients({ tcgdexSets: [tdA, tdB], pokemonSets: [pkA, pkB], failCardId: 'td-b-2' });
  const target = await store();
  const plan = await buildVerifiedPokemonSetCrosswalk(source);

  await assert.rejects(async () => {
    try {
      await syncVerifiedPokemonCatalogue({ store: target, ...source, crosswalk: plan, maxSets: 2, maxCardsPerChunk: 1 });
    } catch (error) {
      assert.deepEqual(error.catalogueResume, {
        startAfterSetId: 'td-a',
        failedSetId: 'td-b',
        restartFailedSetFromBeginning: true,
      });
      throw error;
    }
  }, /simulated source failure/);

  const cards = await listVerifiedCardsFromStore(target, { limit: 50 });
  assert.deepEqual(cards.map((card) => card.name), ['Alpha']);
});
