import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { listVerifiedPriceCapableCardmarketProductIds, scopeCardmarketPriceGuideToMappedProducts } from './cardmarket-market-cycle.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
import { marketObservationFromPostgres } from './market-observation.mjs';

export const storedObservationCandidate = marketObservationFromPostgres;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function compareObservation(existing, incoming) {
  const reconstructed = storedObservationCandidate(existing);
  const ignored = new Set(['observedAt', 'createdAt', 'contentFingerprint']);
  const changes = Object.keys(incoming).filter(key => !ignored.has(key)
    && JSON.stringify(canonical(reconstructed[key])) !== JSON.stringify(canonical(incoming[key])))
    .map(field => ({ field, existing: reconstructed[field], incoming: incoming[field] }));
  return {
    id: incoming.id, sourceRecordId: incoming.sourceRecordId, sourceVariantKey: incoming.sourceVariantKey,
    existingCardIdentityId: existing.card_identity_id, incomingCardIdentityId: incoming.cardIdentityId,
    existingMappingId: existing.card_source_mapping_id, incomingMappingId: incoming.cardSourceMappingId,
    storedFingerprint: existing.content_fingerprint, reconstructedFingerprint: reconstructed.contentFingerprint,
    incomingFingerprint: incoming.contentFingerprint,
    storedFingerprintMatchesPayload: existing.content_fingerprint === reconstructed.contentFingerprint,
    changes,
  };
}

export async function auditCardmarketObservationConflicts(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const store = { pool: async () => client };
    const source = await fetchCardmarketPokemonPriceGuide();
    const productIds = await listVerifiedPriceCapableCardmarketProductIds(store);
    const batch = await prepareCardmarketDailyPriceGuideBatch({ store,
      priceGuidePayload: scopeCardmarketPriceGuideToMappedProducts(source.artifact.payload, productIds),
      observedAt: Date.now(), lanes: ['standard', 'holo'] });
    const { rows } = await client.query('SELECT * FROM fatedrop_market_observations WHERE id = ANY($1::text[])', [batch.observations.map(row => row.id)]);
    const existing = new Map(rows.map(row => [row.id, row]));
    const conflicts = batch.observations.filter(row => existing.has(row.id) && existing.get(row.id).content_fingerprint !== row.contentFingerprint)
      .map(row => compareObservation(existing.get(row.id), row));
    const { priceGuides, ...snapshot } = batch.snapshot;
    return { productionWrites: false, snapshot, artifactSha256: source.artifact.sha256,
      accepted: batch.observations.length, rejected: batch.rejections.length, existing: rows.length,
      newObservations: batch.observations.length - rows.length, conflicts };
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const audit = await auditCardmarketObservationConflicts(pool);
    const output = process.env.MARKET_CONFLICT_AUDIT_OUTPUT;
    if (!output) throw new Error('MARKET_CONFLICT_AUDIT_OUTPUT is required');
    await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(JSON.stringify({ ...audit, conflicts: audit.conflicts.length }));
  } finally { await pool.end(); }
}
