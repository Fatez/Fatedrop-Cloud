import { listVerifiedCardsFromStore } from '../catalogue/store.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { buildCardmarketRehearsalReport } from './cardmarket-rehearsal.mjs';
import {
  fetchCardmarketPokemonPriceGuide,
  fetchCardmarketPokemonSinglesCatalogue,
} from './cardmarket-source-client.mjs';
import { createReadOnlyStoreView } from './read-only-store.mjs';
import { resolveVerifiedExactCardSourceMapping } from './source-mapping-resolver.mjs';
import { resolveVerifiedExactSetSourceMapping } from './set-source-mapping-resolver.mjs';

const DEFAULT_SAMPLE_LIMIT = 50;
const MAX_SAMPLE_LIMIT = 200;

function safeLimit(value) {
  const number = Number(value ?? DEFAULT_SAMPLE_LIMIT);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError('limit must be a positive integer');
  return Math.min(MAX_SAMPLE_LIMIT, number);
}

function comparableName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function positivePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function movementRatio(row) {
  const one = positivePrice(row.avg1);
  const thirty = positivePrice(row.avg30);
  if (one == null || thirty == null) return 0;
  return Math.abs(one - thirty) / Math.max(thirty, 0.01);
}

function productKey(product) {
  return String(product.sourceRecordId);
}

function priceKey(row) {
  return String(row.idProduct);
}

function reasonSetFor(product, row, duplicateNameKeys) {
  const reasons = [];
  const expansion = product.sourceExpansionId == null ? 'unknown' : String(product.sourceExpansionId);
  const duplicateKey = `${expansion}|${comparableName(product.name)}`;
  if (product.sourceExpansionId == null) reasons.push('missing-expansion-scope');
  if (duplicateNameKeys.has(duplicateKey)) reasons.push('duplicate-name-in-expansion');
  if (hasMeaningfulCardmarketLane(row, 'holo')) reasons.push('meaningful-holo-lane');

  const ratio = movementRatio(row);
  if (ratio >= 0.5) reasons.push('high-short-term-volatility');
  else if (ratio >= 0.25) reasons.push('short-term-volatility');

  const anchor = positivePrice(row.avg7) ?? positivePrice(row.trend) ?? positivePrice(row.avg30);
  if (anchor != null && anchor >= 100) reasons.push('high-value');
  const low = positivePrice(row.low);
  if (low != null && low <= 0.5) reasons.push('low-value');
  return reasons;
}

function priority(reasons, productId) {
  const weights = {
    'missing-expansion-scope': 120,
    'duplicate-name-in-expansion': 110,
    'meaningful-holo-lane': 90,
    'high-short-term-volatility': 80,
    'short-term-volatility': 55,
    'high-value': 45,
    'low-value': 35,
  };
  return {
    score: reasons.reduce((total, reason) => total + (weights[reason] || 0), 0),
    productId: Number(productId) || Number.MAX_SAFE_INTEGER,
  };
}

export function selectCardmarketRehearsalSample(products, priceRows, { limit = DEFAULT_SAMPLE_LIMIT } = {}) {
  if (!Array.isArray(products) || !Array.isArray(priceRows)) {
    throw new TypeError('products and priceRows must be arrays');
  }
  const wanted = safeLimit(limit);
  const productsById = new Map(products.map((product) => [productKey(product), product]));

  const nameCounts = new Map();
  for (const product of products) {
    const expansion = product.sourceExpansionId == null ? 'unknown' : String(product.sourceExpansionId);
    const key = `${expansion}|${comparableName(product.name)}`;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const duplicateNameKeys = new Set(
    [...nameCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );

  const candidates = [];
  for (const row of priceRows) {
    const product = productsById.get(priceKey(row));
    if (!product) continue;
    const reasons = reasonSetFor(product, row, duplicateNameKeys);
    const rank = priority(reasons, product.sourceRecordId);
    candidates.push({ product, row, reasons, ...rank });
  }

  candidates.sort((left, right) => (
    right.score - left.score
    || left.productId - right.productId
    || left.product.name.localeCompare(right.product.name)
  ));

  const selected = candidates.slice(0, wanted).map((candidate, index) => Object.freeze({
    rank: index + 1,
    sourceRecordId: candidate.product.sourceRecordId,
    sourceExpansionId: candidate.product.sourceExpansionId,
    name: candidate.product.name,
    reasons: Object.freeze(candidate.reasons.length ? candidate.reasons : ['deterministic-fill']),
    product: candidate.product,
    priceRow: candidate.row,
  }));

  return Object.freeze({
    requested: wanted,
    available: candidates.length,
    selected: Object.freeze(selected),
  });
}

function sourceVariantKeyForLane(priceGuideLane) {
  if (priceGuideLane === 'standard') return 'normal';
  if (priceGuideLane === 'holo') return 'holo';
  throw new TypeError(`unsupported Cardmarket price lane: ${priceGuideLane}`);
}

function artifactSummary(artifact) {
  return Object.freeze({
    url: artifact.url,
    fetchedAt: artifact.fetchedAt,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    etag: artifact.etag,
    lastModified: artifact.lastModified,
  });
}

export async function buildLiveCardmarketRehearsal({
  store,
  fetchImpl = globalThis.fetch,
  limit = DEFAULT_SAMPLE_LIMIT,
  fetchedAt = Date.now(),
  priceGuideUrl,
  singlesCatalogueUrl,
} = {}) {
  const readOnlyStore = createReadOnlyStoreView(store);

  const [priceGuide, catalogue] = await Promise.all([
    fetchCardmarketPokemonPriceGuide({
      ...(priceGuideUrl ? { url: priceGuideUrl } : {}),
      fetchImpl,
      fetchedAt,
    }),
    fetchCardmarketPokemonSinglesCatalogue({
      ...(singlesCatalogueUrl ? { url: singlesCatalogueUrl } : {}),
      fetchImpl,
      fetchedAt,
    }),
  ]);

  const sample = selectCardmarketRehearsalSample(
    catalogue.products,
    priceGuide.snapshot.priceGuides,
    { limit },
  );
  if (sample.selected.length === 0) throw new Error('Cardmarket rehearsal sample contained zero joined products');

  const sampledCataloguePayload = {
    products: sample.selected.map((item) => item.product.rawPayload),
  };
  const sampledPriceGuidePayload = {
    version: priceGuide.artifact.payload.version,
    createdAt: priceGuide.artifact.payload.createdAt,
    priceGuides: sample.selected.map((item) => item.priceRow),
  };

  const report = await buildCardmarketRehearsalReport({
    cataloguePayload: sampledCataloguePayload,
    priceGuidePayload: sampledPriceGuidePayload,
    observedAt: fetchedAt,
    resolveMapping: async ({ sourceName, sourceRecordId, priceGuideLane }) => (
      resolveVerifiedExactCardSourceMapping(readOnlyStore, {
        sourceName,
        sourceRecordId,
        sourceVariantKey: sourceVariantKeyForLane(priceGuideLane),
      })
    ),
    resolveVerifiedSetCards: async (product) => {
      if (product.sourceExpansionId == null) return null;
      const setMapping = await resolveVerifiedExactSetSourceMapping(readOnlyStore, {
        sourceName: 'cardmarket',
        sourceRecordId: String(product.sourceExpansionId),
        tcgCode: 'pokemon',
      });
      if (!setMapping) return null;
      return listVerifiedCardsFromStore(readOnlyStore, {
        setId: setMapping.setId,
        languageCode: 'en',
        limit: 500,
      });
    },
  });

  return Object.freeze({
    ...report,
    persistenceAuthorized: false,
    liveSource: true,
    sample: Object.freeze({
      requested: sample.requested,
      available: sample.available,
      selected: Object.freeze(sample.selected.map((item) => Object.freeze({
        rank: item.rank,
        sourceRecordId: item.sourceRecordId,
        sourceExpansionId: item.sourceExpansionId,
        name: item.name,
        reasons: item.reasons,
      }))),
    }),
    artifacts: Object.freeze({
      priceGuide: artifactSummary(priceGuide.artifact),
      singlesCatalogue: artifactSummary(catalogue.artifact),
    }),
  });
}
