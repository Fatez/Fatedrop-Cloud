import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresStore } from '../../stores/postgres-store.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { ingestCardmarketDailyPriceGuide } from './cardmarket-daily-ingest.mjs';

const ALLOWED_VARIANTS = new Set(['normal', 'holo', 'reverse', 'metal']);
const PRICE_VARIANTS = new Set(['normal', 'holo']);

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function requireExactArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new Error('price-slice artifact is required');
  if (artifact.safety?.exactOnly !== true || artifact.safety?.fuzzyMatching !== false || artifact.safety?.mappingConflictsQuarantined !== true) {
    throw new Error('artifact does not satisfy exact-only mapping safety contract');
  }
  if (artifact.safety?.reverseAndMetalNotCoercedIntoStandardPriceLane !== true) {
    throw new Error('artifact does not preserve finish-specific price-lane safety');
  }
}

function groupBySet(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.setId)) grouped.set(row.setId, []);
    grouped.get(row.setId).push(row);
  }
  return grouped;
}

async function persistSetMappings(client, setId, mappings, now) {
  const keys = mappings.map((m) => `${m.sourceRecordId}|${m.sourceVariantKey}`);
  if (new Set(keys).size !== keys.length) throw new Error(`duplicate source mapping key inside set ${setId}`);

  await client.query('BEGIN');
  try {
    for (const mapping of mappings) {
      const { rows: existing } = await client.query(
        `SELECT card_identity_id FROM fatedrop_card_source_mappings
         WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,
        [String(mapping.sourceRecordId), mapping.sourceVariantKey],
      );
      if (existing[0] && existing[0].card_identity_id !== mapping.cardIdentityId) {
        throw new Error(`Cardmarket source collision ${mapping.sourceRecordId}|${mapping.sourceVariantKey}`);
      }
      await client.query(
        `INSERT INTO fatedrop_card_source_mappings
          (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,first_observed_at,last_observed_at)
         VALUES ($1,$2,'cardmarket',$3,$4,$5,$6,$7,$7)
         ON CONFLICT (source_name,source_record_id,source_variant_key)
         DO UPDATE SET source_url=COALESCE(EXCLUDED.source_url,fatedrop_card_source_mappings.source_url),
                       source_version=COALESCE(EXCLUDED.source_version,fatedrop_card_source_mappings.source_version),
                       last_observed_at=GREATEST(fatedrop_card_source_mappings.last_observed_at,EXCLUDED.last_observed_at)`,
        [mapping.id, mapping.cardIdentityId, String(mapping.sourceRecordId), mapping.sourceVariantKey, mapping.sourceUrl, mapping.sourceVersion, now],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function main() {
  const artifactPath = argValue('artifact');
  if (!artifactPath) throw new Error('--artifact=<fateprice-expanded-price-slice-v2.json> is required');
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const artifact = JSON.parse(await readFile(resolve(artifactPath), 'utf8'));
  requireExactArtifact(artifact);

  const allMappings = (artifact.mappings || []).filter((m) => m.sourceName === 'cardmarket');
  if (!allMappings.length) throw new Error('no exact Cardmarket mappings found in artifact');
  if (allMappings.some((m) => !ALLOWED_VARIANTS.has(m.sourceVariantKey))) throw new Error('unexpected Cardmarket mapping variant');
  if (allMappings.some((m) => m.proof?.reason !== 'tcgdex_explicit_cardmarket_product_id_verified_in_official_catalogue')) {
    throw new Error('mapping artifact contains a row without explicit verified Cardmarket product proof');
  }

  const store = new PostgresStore(databaseUrl);
  const pool = await store.pool();
  const client = await pool.connect();
  const now = Date.now();
  const successful = [];
  const rejected = [];

  try {
    const { rows: verifiedSets } = await client.query(`SELECT id,name FROM fatedrop_card_sets WHERE verification_status='verified' ORDER BY id`);
    const setNames = new Map(verifiedSets.map((row) => [row.id, row.name]));
    const { rows: verifiedCards } = await client.query(`SELECT id,set_id FROM fatedrop_card_identities WHERE verification_status='verified'`);
    const cardSet = new Map(verifiedCards.map((row) => [row.id, row.set_id]));

    const eligible = allMappings.filter((m) => setNames.has(m.setId) && cardSet.get(m.cardIdentityId) === m.setId);
    const bySet = groupBySet(eligible);

    for (const setId of [...bySet.keys()].sort()) {
      const mappings = bySet.get(setId);
      try {
        await persistSetMappings(client, setId, mappings, now);
        successful.push({ setId, setName: setNames.get(setId), mappings: mappings.length });
      } catch (error) {
        rejected.push({ setId, setName: setNames.get(setId), mappings: mappings.length, reason: error?.message || String(error) });
      }
    }
  } finally {
    client.release();
  }

  if (!successful.length) throw new Error('no production-verified sets had a clean exact mapping tranche');

  const successfulSetIds = new Set(successful.map((row) => row.setId));
  const successfulMappings = allMappings.filter((m) => successfulSetIds.has(m.setId));
  const source = await fetchCardmarketPokemonPriceGuide({ fetchedAt: Date.now() });
  const priceProductIds = new Set(successfulMappings.filter((m) => PRICE_VARIANTS.has(m.sourceVariantKey)).map((m) => String(m.sourceRecordId)));
  const scopedPayload = {
    ...source.artifact.payload,
    priceGuides: (source.artifact.payload.priceGuides || []).filter((row) => priceProductIds.has(String(row?.idProduct ?? ''))),
  };
  if (!scopedPayload.priceGuides.length) throw new Error('fresh Cardmarket price guide contained no rows for the clean production mapping tranche');

  const ingest = await ingestCardmarketDailyPriceGuide({
    store,
    priceGuidePayload: scopedPayload,
    observedAt: Date.now(),
    lanes: ['standard', 'holo'],
  });

  const { rows: verification } = await pool.query(`SELECT
    COUNT(DISTINCT s.id) FILTER (WHERE s.verification_status='verified')::int AS verified_sets,
    COUNT(DISTINCT c.id) FILTER (WHERE c.verification_status='verified')::int AS verified_identities,
    COUNT(DISTINCT m.card_identity_id)::int AS mapped_identities,
    COUNT(DISTINCT o.card_identity_id)::int AS priced_identities,
    COUNT(o.*)::int AS observation_rows
    FROM fatedrop_card_sets s
    LEFT JOIN fatedrop_card_identities c ON c.set_id=s.id
    LEFT JOIN fatedrop_card_source_mappings m ON m.card_identity_id=c.id AND m.source_name='cardmarket'
    LEFT JOIN fatedrop_market_observations o ON o.card_identity_id=c.id
    WHERE s.verification_status='verified'`);

  console.log(JSON.stringify({
    ok: true,
    successfulSets: successful.length,
    rejectedSets: rejected.length,
    exactMappingsPersistedOrConfirmed: successfulMappings.length,
    mappingVariants: Object.fromEntries(['normal','holo','reverse','metal'].map((v) => [v, successfulMappings.filter((m) => m.sourceVariantKey === v).length])),
    freshPriceGuideRows: scopedPayload.priceGuides.length,
    ingest,
    verification: verification[0],
    successful,
    rejected,
    note: 'reverse/metal mappings remain unpriced unless a dedicated authoritative price lane exists; no cross-lane substitution is performed',
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
