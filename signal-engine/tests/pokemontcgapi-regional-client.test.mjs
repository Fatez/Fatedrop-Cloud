import test from 'node:test';
import assert from 'node:assert/strict';
import { createPokemonTcgApiRegionalClient } from '../src/trader/catalogue/pokemontcgapi-client.mjs';

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async json() { return body; },
  };
}

test('requires a server-side API key', () => {
  assert.throws(() => createPokemonTcgApiRegionalClient({ apiKey: '' }), /PTCG_API_KEY/);
});

test('sends API key only as a header and follows opaque pagination exactly once', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (calls.length === 1) {
      return response({
        data: [{ id: 'a' }, { id: 'b' }],
        meta: { count: 2, has_more: true },
        links: { next: 'https://api.pokemontcgapi.com/v1/sets?region=JP&limit=250&cursor=opaque-1' },
      });
    }
    return response({ data: [{ id: 'c' }], meta: { count: 1, has_more: false }, links: { next: null } });
  };

  const client = createPokemonTcgApiRegionalClient({ apiKey: 'secret-key', fetchImpl });
  const rows = await client.listSets({ region: 'JP' });
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['X-Api-Key'], 'secret-key');
  assert.equal(calls[1].headers['X-Api-Key'], 'secret-key');
  assert.equal(calls.some((call) => call.url.includes('secret-key')), false);
  assert.match(calls[1].url, /cursor=opaque-1/);
});

test('rejects repeated pagination rows instead of silently double-counting catalogue evidence', async () => {
  let call = 0;
  const client = createPokemonTcgApiRegionalClient({
    apiKey: 'key',
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? response({ data: [{ id: 'same' }], links: { next: 'https://api.pokemontcgapi.com/v1/sets?limit=250&cursor=x' } })
        : response({ data: [{ id: 'same' }], links: { next: null } });
    },
  });
  await assert.rejects(client.listSets(), /repeated row id/);
});

test('refuses an off-origin pagination URL', async () => {
  const client = createPokemonTcgApiRegionalClient({
    apiKey: 'key',
    fetchImpl: async () => response({
      data: [{ id: 'a' }],
      links: { next: 'https://example.test/v1/sets?cursor=stolen' },
    }),
  });
  await assert.rejects(client.listSets(), /untrusted next URL/);
});

test('set cards use the documented set endpoint and keep legacy evidence untouched', async () => {
  const calls = [];
  const client = createPokemonTcgApiRegionalClient({
    apiKey: 'key',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response({
        data: [{ id: 'bs-4', legacy_id: 'base1-4', name: 'Charizard', number: '4', set_code: 'bs' }],
        links: { next: null },
      });
    },
  });
  const cards = await client.listCardsBySet('base1');
  assert.equal(cards[0].legacy_id, 'base1-4');
  assert.match(calls[0], /\/v1\/sets\/base1\/cards\?limit=250$/);
});

test('rejects unsupported region labels before making a request', async () => {
  let called = false;
  const client = createPokemonTcgApiRegionalClient({ apiKey: 'key', fetchImpl: async () => { called = true; } });
  await assert.rejects(client.listSets({ region: 'EU' }), /WEST, JP, CN or KR/);
  assert.equal(called, false);
});
