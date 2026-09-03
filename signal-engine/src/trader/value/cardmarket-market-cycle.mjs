import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
import { persistMarketEvidenceBatch } from './market-store.mjs';
import { buildMarketDataReadinessReport } from './market-data-readiness.mjs';

const MODES = new Set(['dry-run', 'persist']);

function modeValue(value) {
  const mode = String(value || 'dry-run').trim().toLowerCase();
  if (!MODES.has(mode)) throw new TypeError('mode must be dry-run or persist');
  return mode;
}

function artifactSummary(artifact) {
  return Object.freeze({
    url: artifact.url,
    fetchedAt: artifact.fetchedAt,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    etag: artifact.etag,
    lastModified: artifact.lastModified,
  });
}

export async function runCardmarketPokemonMarketCycle({
  store,
  mode = 'dry-run',
  fetchedAt = Date.now(),
  observedAt = fetchedAt,
  fetchImpl = globalThis.fetch,
  sourceUrl,
  maxAgeMs,
  futureSkewMs,
  timeoutMs,
  maxBytes,
} = {}) {
  const selectedMode = modeValue(mode);
  if (!store || (typeof store.read !== 'function' && typeof store.pool !== 'function')) {
    throw new TypeError('Fate Value store is required');
  }

  const source = await fetchCardmarketPokemonPriceGuide({
    ...(sourceUrl ? { url: sourceUrl } : {}),
    fetchImpl,
    fetchedAt,
    ...(maxAgeMs == null ? {} : { maxAgeMs }),
    ...(futureSkewMs == null ? {} : { futureSkewMs }),
    ...(timeoutMs == null ? {} : { timeoutMs }),
    ...(maxBytes == null ? {} : { maxBytes }),
  });

  const batch = await prepareCardmarketDailyPriceGuideBatch({
    store,
    priceGuidePayload: source.artifact.payload,
    observedAt,
  });

  let persistence = null;
  if (selectedMode === 'persist') {
    persistence = await persistMarketEvidenceBatch(store, batch);
  }

  const readiness = await buildMarketDataReadinessReport(store, { sourceName: 'cardmarket' });

  return Object.freeze({
    mode: selectedMode,
    persistenceAuthorized: selectedMode === 'persist',
    artifact: artifactSummary(source.artifact),
    sourceSnapshotId: batch.snapshot.sourceSnapshotId,
    sourceEffectiveAt: batch.snapshot.sourceEffectiveAt,
    sourceCurrency: batch.snapshot.currencyCode,
    recordsSeen: batch.run.recordsSeen,
    recordsAccepted: batch.run.recordsAccepted,
    recordsRejected: batch.run.recordsRejected,
    status: batch.run.status,
    persistence: persistence ? Object.freeze({ ...persistence }) : null,
    readiness,
  });
}
