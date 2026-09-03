import { createHash } from 'node:crypto';

import { adaptCardmarketPriceGuideSnapshot } from './cardmarket-adapter.mjs';
import { adaptCardmarketCatalogue } from './cardmarket-catalogue-adapter.mjs';
import { assertFatePriceProviderApproved } from './provider-policy.mjs';

export const CARDMARKET_POKEMON_SOURCE_URLS = Object.freeze({
  priceGuide: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json',
  singlesCatalogue: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json',
});

const ALLOWED_SOURCE_HOSTS = Object.freeze(new Set([
  'downloads.s3.cardmarket.com',
]));

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_PRICE_GUIDE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 6 * 60 * 60 * 1000;

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} function is required`);
  return value;
}

function positiveInteger(value, fallback, field) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return candidate;
}

function nonNegativeInteger(value, fallback, field) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return candidate;
}

function approvedUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new TypeError('Cardmarket source URL must use HTTPS');
  if (!ALLOWED_SOURCE_HOSTS.has(url.hostname)) {
    throw new TypeError(`Cardmarket source host is not approved: ${url.hostname}`);
  }
  if (url.username || url.password) throw new TypeError('Cardmarket source URL must not contain credentials');
  return url;
}

function headerValue(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(headerValue(response, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Cardmarket artifact exceeds byte limit (${declaredLength} > ${maxBytes})`);
  }

  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('Cardmarket artifact exceeds byte limit');
    return bytes;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error('Cardmarket artifact exceeds byte limit');
    chunks.push(bytes);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function parseJsonBytes(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('Cardmarket artifact was empty');
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || text.startsWith('<HTML')) {
    throw new Error('Cardmarket artifact unexpectedly contained HTML');
  }
  try {
    return { text, payload: JSON.parse(text) };
  } catch (error) {
    throw new Error(`Cardmarket artifact was not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function fetchCardmarketJsonArtifact(urlValue, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchedAt = Date.now(),
} = {}) {
  // Cardmarket's public downloadable catalogue/price-guide files are the only
  // reviewed Cardmarket acquisition mode approved for FateDrop V1. Keeping the
  // policy assertion inside the fetch path prevents a future caller from
  // bypassing the legal/source review boundary by reusing this transport.
  assertFatePriceProviderApproved('cardmarket-public-download');

  requireFunction(fetchImpl, 'fetchImpl');
  const url = approvedUrl(urlValue);
  const safeTimeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const safeMaxBytes = positiveInteger(maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json, application/octet-stream;q=0.9, text/plain;q=0.5',
        'user-agent': 'FateDrop-FateValueLab/1.0',
      },
    });
    if (!response?.ok) {
      throw new Error(`Cardmarket source request failed with HTTP ${response?.status ?? 'unknown'}`);
    }

    const contentType = String(headerValue(response, 'content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new Error('Cardmarket source returned HTML instead of data');
    }

    const bytes = await readLimitedBody(response, safeMaxBytes);
    const { payload } = parseJsonBytes(bytes);
    return Object.freeze({
      url: url.toString(),
      fetchedAt: Number(fetchedAt),
      byteLength: bytes.byteLength,
      sha256: checksum(bytes),
      contentType: contentType || null,
      etag: headerValue(response, 'etag'),
      lastModified: headerValue(response, 'last-modified'),
      payload,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCardmarketPokemonPriceGuide({
  url = CARDMARKET_POKEMON_SOURCE_URLS.priceGuide,
  fetchImpl = globalThis.fetch,
  fetchedAt = Date.now(),
  maxAgeMs = DEFAULT_PRICE_GUIDE_MAX_AGE_MS,
  futureSkewMs = DEFAULT_FUTURE_SKEW_MS,
  ...transport
} = {}) {
  const artifact = await fetchCardmarketJsonArtifact(url, {
    fetchImpl,
    fetchedAt,
    ...transport,
  });
  const snapshot = adaptCardmarketPriceGuideSnapshot(artifact.payload);
  const age = Number(fetchedAt) - snapshot.sourceEffectiveAt;
  const safeMaxAgeMs = positiveInteger(maxAgeMs, DEFAULT_PRICE_GUIDE_MAX_AGE_MS, 'maxAgeMs');
  const safeFutureSkewMs = nonNegativeInteger(futureSkewMs, DEFAULT_FUTURE_SKEW_MS, 'futureSkewMs');

  if (age > safeMaxAgeMs) {
    throw new Error(`Cardmarket price guide is stale by ${age}ms`);
  }
  if (age < -safeFutureSkewMs) {
    throw new Error(`Cardmarket price guide timestamp is unexpectedly in the future by ${Math.abs(age)}ms`);
  }

  return Object.freeze({ artifact, snapshot });
}

export async function fetchCardmarketPokemonSinglesCatalogue({
  url = CARDMARKET_POKEMON_SOURCE_URLS.singlesCatalogue,
  fetchImpl = globalThis.fetch,
  fetchedAt = Date.now(),
  ...transport
} = {}) {
  const artifact = await fetchCardmarketJsonArtifact(url, {
    fetchImpl,
    fetchedAt,
    ...transport,
  });
  const products = adaptCardmarketCatalogue(artifact.payload);
  return Object.freeze({ artifact, products });
}
