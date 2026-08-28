import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CARDMARKET_POKEMON_SOURCE_URLS,
  fetchCardmarketJsonArtifact,
  fetchCardmarketPokemonPriceGuide,
  fetchCardmarketPokemonSinglesCatalogue,
} from '../src/trader/value/cardmarket-source-client.mjs';

const FETCHED_AT = Date.parse('2026-08-28T01:00:00.000Z');

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function priceGuide(createdAt = '2026-08-28T00:00:00+0000') {
  return {
    version: 1,
    createdAt,
    priceGuides: [{
      idProduct: 668227,
      idCategory: 51,
      avg: 8.93,
      low: 5,
      trend: 11.25,
      avg1: 8.45,
      avg7: 8.8,
      avg30: 9.39,
      'avg-holo': null,
      'low-holo': null,
      'trend-holo': 0,
      'avg1-holo': null,
      'avg7-holo': null,
      'avg30-holo': null,
    }],
  };
}

function catalogue() {
  return {
    products: [{
      idProduct: 668227,
      idCategory: 51,
      categoryName: 'Singles',
      idExpansion: 777,
      name: 'Pikachu ex',
      dateAdded: '2026-08-01 00:00:00',
    }],
  };
}

test('price guide download validates source data and preserves artifact provenance', async () => {
  const raw = JSON.stringify(priceGuide());
  const expectedHash = createHash('sha256').update(new TextEncoder().encode(raw)).digest('hex');
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), CARDMARKET_POKEMON_SOURCE_URLS.priceGuide);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    return new Response(raw, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: '"abc123"',
        'last-modified': 'Fri, 28 Aug 2026 00:05:00 GMT',
      },
    });
  };

  const result = await fetchCardmarketPokemonPriceGuide({ fetchImpl, fetchedAt: FETCHED_AT });

  assert.equal(result.artifact.sha256, expectedHash);
  assert.equal(result.artifact.etag, '"abc123"');
  assert.equal(result.snapshot.sourceName, 'cardmarket');
  assert.equal(result.snapshot.currencyCode, 'EUR');
  assert.equal(result.snapshot.priceGuides.length, 1);
});

test('singles catalogue download validates the adapted catalogue before returning it', async () => {
  const result = await fetchCardmarketPokemonSinglesCatalogue({
    fetchImpl: async () => jsonResponse(catalogue()),
    fetchedAt: FETCHED_AT,
  });

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].sourceRecordId, '668227');
  assert.equal(result.products[0].name, 'Pikachu ex');
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
});

test('source client rejects unapproved hosts and non-HTTPS URLs before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({}); };

  await assert.rejects(
    fetchCardmarketJsonArtifact('https://example.com/price_guide_6.json', { fetchImpl }),
    /host is not approved/,
  );
  await assert.rejects(
    fetchCardmarketJsonArtifact('http://downloads.s3.cardmarket.com/file.json', { fetchImpl }),
    /must use HTTPS/,
  );
  assert.equal(calls, 0);
});

test('source client rejects HTML, invalid JSON and oversized responses', async () => {
  await assert.rejects(
    fetchCardmarketJsonArtifact(CARDMARKET_POKEMON_SOURCE_URLS.priceGuide, {
      fetchImpl: async () => new Response('<html>blocked</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    }),
    /HTML/,
  );

  await assert.rejects(
    fetchCardmarketJsonArtifact(CARDMARKET_POKEMON_SOURCE_URLS.priceGuide, {
      fetchImpl: async () => new Response('{not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /not valid JSON/,
  );

  await assert.rejects(
    fetchCardmarketJsonArtifact(CARDMARKET_POKEMON_SOURCE_URLS.priceGuide, {
      fetchImpl: async () => new Response('1234567890', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '10',
        },
      }),
      maxBytes: 5,
    }),
    /exceeds byte limit/,
  );
});

test('source client rejects HTTP errors rather than trying to parse their body', async () => {
  await assert.rejects(
    fetchCardmarketJsonArtifact(CARDMARKET_POKEMON_SOURCE_URLS.priceGuide, {
      fetchImpl: async () => new Response('{"error":true}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /HTTP 503/,
  );
});

test('price guide freshness gate rejects stale and implausibly future snapshots', async () => {
  await assert.rejects(
    fetchCardmarketPokemonPriceGuide({
      fetchImpl: async () => jsonResponse(priceGuide('2026-08-20T00:00:00+0000')),
      fetchedAt: FETCHED_AT,
      maxAgeMs: 72 * 60 * 60 * 1000,
    }),
    /is stale/,
  );

  await assert.rejects(
    fetchCardmarketPokemonPriceGuide({
      fetchImpl: async () => jsonResponse(priceGuide('2026-08-29T00:00:00+0000')),
      fetchedAt: FETCHED_AT,
      futureSkewMs: 60 * 60 * 1000,
    }),
    /unexpectedly in the future/,
  );
});

test('transport timeout aborts an unresponsive source request', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted-by-test')), { once: true });
  });

  await assert.rejects(
    fetchCardmarketJsonArtifact(CARDMARKET_POKEMON_SOURCE_URLS.priceGuide, {
      fetchImpl,
      timeoutMs: 5,
    }),
    /aborted-by-test/,
  );
});
