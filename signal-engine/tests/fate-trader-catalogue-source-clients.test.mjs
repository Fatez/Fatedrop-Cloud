import test from 'node:test';
import assert from 'node:assert/strict';
import { createPokemonTcgClient, createTcgdexClient } from '../src/trader/catalogue/source-clients.mjs';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('TCGdex client uses language-scoped v2 catalogue routes', async () => {
  const calls = [];
  const client = createTcgdexClient({
    languageCode: 'en',
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/en/sets')) return response([{ id: 'x' }]);
      return response({ id: 'x' });
    },
  });

  await client.listSets();
  await client.getSet('sv1');
  await client.getCard('sv1-1');

  assert.equal(calls[0], 'https://api.tcgdex.net/v2/en/sets');
  assert.equal(calls[1], 'https://api.tcgdex.net/v2/en/sets/sv1');
  assert.equal(calls[2], 'https://api.tcgdex.net/v2/en/cards/sv1-1');
});

test('Pokémon TCG API client paginates until totalCount is reached and sends optional API key', async () => {
  const calls = [];
  const client = createPokemonTcgClient({
    pageSize: 2,
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get('page'));
      if (page === 1) return response({ data: [{ id: 'a' }, { id: 'b' }], count: 2, totalCount: 3 });
      return response({ data: [{ id: 'c' }], count: 1, totalCount: 3 });
    },
  });

  const rows = await client.listSets();

  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['x-api-key'], 'test-key');
});

test('Pokémon TCG API card-set query does not assume source IDs equal FateDrop IDs', async () => {
  let calledUrl = null;
  const client = createPokemonTcgClient({
    fetchImpl: async (url) => {
      calledUrl = url;
      return response({ data: [], count: 0, totalCount: 0 });
    },
  });

  await client.listCardsBySet('provider-set-123');
  const parsed = new URL(calledUrl);
  assert.equal(parsed.pathname, '/v2/cards');
  assert.equal(parsed.searchParams.get('q'), 'set.id:"provider-set-123"');
});

test('catalogue clients fail closed on non-success source responses', async () => {
  const client = createTcgdexClient({ fetchImpl: async () => response({}, 503) });
  await assert.rejects(() => client.getCard('x'), /Catalogue source request failed \(503\)/);
});
