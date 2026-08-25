import test from 'node:test';
import assert from 'node:assert/strict';
import { createPokemonTcgClient, createTcgdexClient } from '../src/trader/catalogue/source-clients.mjs';

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
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
  await client.getSeries('tcgp');
  await client.getSet('sv1');
  await client.getCard('sv1-1');

  assert.equal(calls[0], 'https://api.tcgdex.net/v2/en/sets');
  assert.equal(calls[1], 'https://api.tcgdex.net/v2/en/series/tcgp');
  assert.equal(calls[2], 'https://api.tcgdex.net/v2/en/sets/sv1');
  assert.equal(calls[3], 'https://api.tcgdex.net/v2/en/cards/sv1-1');
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

test('catalogue clients retry bounded provider throttling and respect Retry-After', async () => {
  let calls = 0;
  const delays = [];
  const client = createTcgdexClient({
    retryAttempts: 3,
    sleepImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response({}, 429, { 'retry-after': '2' });
      return response({ id: 'ok' });
    },
  });

  const card = await client.getCard('x');
  assert.equal(card.id, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test('catalogue clients retry transient fetch failures and 5xx responses only within the configured bound', async () => {
  let calls = 0;
  const delays = [];
  const client = createTcgdexClient({
    retryAttempts: 3,
    sleepImpl: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary network failure');
      if (calls === 2) return response({}, 503);
      return response({ id: 'recovered' });
    },
  });

  assert.equal((await client.getCard('x')).id, 'recovered');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('catalogue clients fail immediately on non-retryable source responses', async () => {
  let calls = 0;
  const client = createTcgdexClient({
    retryAttempts: 4,
    sleepImpl: async () => { throw new Error('sleep should not run'); },
    fetchImpl: async () => { calls += 1; return response({}, 404); },
  });
  await assert.rejects(() => client.getCard('x'), /Catalogue source request failed \(404\)/);
  assert.equal(calls, 1);
});

test('catalogue clients still fail closed when retryable source responses never recover', async () => {
  let calls = 0;
  const client = createTcgdexClient({
    retryAttempts: 2,
    sleepImpl: async () => {},
    fetchImpl: async () => { calls += 1; return response({}, 503); },
  });
  await assert.rejects(() => client.getCard('x'), /Catalogue source request failed \(503\)/);
  assert.equal(calls, 2);
});
