import { PostgresStore } from '../../stores/postgres-store.mjs';
import { CARDMARKET_PRICE_LANES } from './cardmarket-adapter.mjs';
import { ingestCardmarketDailyPriceGuide, prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function lanes(value) {
  if (!value) return Object.freeze(['standard']);
  const requested = [...new Set(String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (!requested.length) throw new TypeError('--lanes must contain at least one lane');
  for (const lane of requested) {
    if (!CARDMARKET_PRICE_LANES.includes(lane)) throw new TypeError(`Unsupported Cardmarket lane: ${lane}`);
  }
  return Object.freeze(requested);
}

function positiveInt(value, fallback, field) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${field} must be a positive integer`);
  return parsed;
}

async function main() {
  const write = process.argv.includes('--write');
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const selectedLanes = lanes(argValue('lanes'));
  const minAccepted = positiveInt(argValue('min-accepted'), 1, '--min-accepted');
  const store = new PostgresStore(databaseUrl);
  const fetchedAt = Date.now();
  const source = await fetchCardmarketPokemonPriceGuide({ fetchedAt });
  const batch = await prepareCardmarketDailyPriceGuideBatch({
    store,
    priceGuidePayload: source.artifact.payload,
    observedAt: fetchedAt,
    lanes: selectedLanes,
  });

  const base = {
    mode: write ? 'write' : 'dry-run',
    writesPerformed: false,
    generatedAt: new Date().toISOString(),
    lanes: selectedLanes,
    source: {
      url: source.artifact.url,
      fetchedAt: source.artifact.fetchedAt,
      lastModified: source.artifact.lastModified,
      sha256: source.artifact.sha256,
      byteLength: source.artifact.byteLength,
      sourceSnapshotId: batch.snapshot.sourceSnapshotId,
      sourceEffectiveAt: batch.snapshot.sourceEffectiveAt,
      currencyCode: batch.snapshot.currencyCode,
    },
    recordsSeen: batch.run.recordsSeen,
    recordsAccepted: batch.run.recordsAccepted,
    recordsRejected: batch.run.recordsRejected,
    rejectionCodes: batch.rejections.reduce((counts, row) => {
      counts[row.rejectionCode] = (counts[row.rejectionCode] || 0) + 1;
      return counts;
    }, {}),
  };

  if (!write) {
    console.log(JSON.stringify(base, null, 2));
    return;
  }
  if (!enabled(process.env.FATEDROP_CARDMARKET_DAILY_WRITE_ENABLED)) {
    throw new Error('Cardmarket daily writes are disabled. Set FATEDROP_CARDMARKET_DAILY_WRITE_ENABLED=true explicitly.');
  }
  if (batch.run.recordsAccepted < minAccepted) {
    throw new Error(`Cardmarket daily ingest held: ${batch.run.recordsAccepted} accepted rows is below --min-accepted=${minAccepted}`);
  }

  const result = await ingestCardmarketDailyPriceGuide({
    store,
    priceGuidePayload: source.artifact.payload,
    observedAt: fetchedAt,
    lanes: selectedLanes,
  });
  console.log(JSON.stringify({ ...base, writesPerformed: true, persistence: result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, writesPerformed: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
