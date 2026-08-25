import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePokemonCatalogueSnapshots } from '../src/trader/catalogue/snapshot-compiler.mjs';
import { loadCompiledCatalogueArtifact, validateCompiledCatalogueArtifact } from '../src/trader/catalogue/bulk-loader.mjs';

async function artifactFixture() {
  const tcgdexSnapshot = {
    meta: { source: 'tcgdex/cards-database', commit: 'tcgdex-commit', language: 'en' },
    series: { sv: { id: 'sv', name: 'Scarlet & Violet', sets: [{ id: 'svtest', name: 'Test Set' }] } },
    sets: {
      svtest: {
        id: 'svtest', name: 'Test Set', serie: { id: 'sv', name: 'Scarlet & Violet' },
        cardCount: { official: 2, total: 2 }, releaseDate: '2024-01-01',
        cards: [
          { id: 'svtest-001', localId: '001', name: 'Bulbasaur' },
          { id: 'svtest-002', localId: '002', name: 'Ivysaur' },
        ],
      },
    },
    cards: {
      'svtest-001': {
        id: 'svtest-001', localId: '001', name: 'Bulbasaur', rarity: 'Common', category: 'Pokemon',
        set: { id: 'svtest', name: 'Test Set' },
        variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
      },
      'svtest-002': {
        id: 'svtest-002', localId: '002', name: 'Ivysaur', rarity: 'Uncommon', category: 'Pokemon',
        set: { id: 'svtest', name: 'Test Set' },
        variants: { firstEdition: false, holo: false, normal: true, reverse: false, wPromo: false },
      },
    },
  };
  const set = { id: 'sv-test', name: 'Test Set', series: 'Scarlet & Violet', printedTotal: 2, total: 2, releaseDate: '2024/01/01' };
  const pokemonTcgSnapshot = {
    meta: { source: 'PokemonTCG/pokemon-tcg-data', commit: 'pokemon-commit', language: 'en' },
    sets: [set],
    cardsBySet: {
      'sv-test': [
        { id: 'sv-test-1', name: 'Bulbasaur', number: '1', rarity: 'Common', supertype: 'Pokémon', set },
        { id: 'sv-test-2', name: 'Ivysaur', number: '2', rarity: 'Uncommon', supertype: 'Pokémon', set },
      ],
    },
  };
  return compilePokemonCatalogueSnapshots({ tcgdexSnapshot, pokemonTcgSnapshot, verifiedAt: 1_700_000_000_000 });
}

function fakeStore({ mappingConflict = false } = {}) {
  const calls = [];
  let conflictReturned = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (mappingConflict && !conflictReturned && sql.includes('JOIN fatedrop_card_set_source_mappings')) {
        conflictReturned = true;
        return { rows: [{ sourceName: 'tcgdex', sourceRecordId: 'svtest', existing_set_id: 'wrong', incoming_set_id: 'right' }], rowCount: 1 };
      }
      if (sql.includes('JOIN fatedrop_card_set_source_mappings') || sql.includes('JOIN fatedrop_card_source_mappings')) {
        return { rows: [], rowCount: 0 };
      }
      if (params[0]) return { rows: [], rowCount: JSON.parse(params[0]).length };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    calls,
    store: { async pool() { return { connect: async () => client }; } },
  };
}

test('compiled catalogue validation locks source versions to pinned snapshot commits', async () => {
  const artifact = await artifactFixture();
  const summary = validateCompiledCatalogueArtifact(artifact);
  assert.equal(summary.compilation.verifiedSetCount, 1);
  assert.equal(summary.counts.cardIdentities, 3);

  const broken = structuredClone(artifact);
  broken.rows.cardSourceMappings[0].sourceVersion = 'other-commit';
  assert.throws(() => validateCompiledCatalogueArtifact(broken), /source version mismatch/);
});

test('bulk loader writes compiled rows in set-based chunks inside one transaction', async () => {
  const artifact = await artifactFixture();
  const { store, calls } = fakeStore();
  const result = await loadCompiledCatalogueArtifact({ store, artifact, chunkSize: 100 });

  assert.equal(result.status, 'complete');
  assert.equal(result.affectedRows.sets, 1);
  assert.equal(result.affectedRows.printings, 2);
  assert.equal(result.affectedRows.cardIdentities, 3);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-2).sql, 'COMMIT');
  assert.equal(calls.at(-1).sql, 'RELEASE');
  assert.ok(calls.some((call) => call.sql.includes('jsonb_to_recordset')));
  assert.ok(calls.length < 20, `expected set-based loading, saw ${calls.length} queries`);
});

test('bulk loader rolls back before inserts when an existing source mapping points elsewhere', async () => {
  const artifact = await artifactFixture();
  const { store, calls } = fakeStore({ mappingConflict: true });

  await assert.rejects(
    () => loadCompiledCatalogueArtifact({ store, artifact, chunkSize: 100 }),
    /set source mapping conflict/,
  );
  assert.equal(calls[0].sql, 'BEGIN');
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(calls.at(-1).sql, 'RELEASE');
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO fatedrop_tcgs')), false);
});
