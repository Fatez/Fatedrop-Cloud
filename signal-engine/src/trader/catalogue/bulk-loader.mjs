const ARTIFACT_FORMAT = 'fatedrop-pokemon-catalogue-v1';
const DEFAULT_CHUNK_SIZE = 2000;

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function sourceCommit(sourceName, artifact) {
  if (sourceName === 'tcgdex') return requireText(artifact.sources?.tcgdex?.commit, 'sources.tcgdex.commit');
  if (sourceName === 'pokemontcg-api') return requireText(artifact.sources?.pokemonTcg?.commit, 'sources.pokemonTcg.commit');
  return null;
}

function assertUniqueIds(rows, field) {
  const seen = new Set();
  for (const row of rows) {
    const id = requireText(row?.id, `${field}.id`);
    if (seen.has(id)) throw new Error(`${field} contains duplicate id ${id}`);
    seen.add(id);
  }
}

function countMatches(artifact, key, rows) {
  const declared = Number(artifact.counts?.[key]);
  if (!Number.isInteger(declared) || declared !== rows.length) {
    throw new Error(`compiled catalogue count mismatch for ${key}: declared=${artifact.counts?.[key]} actual=${rows.length}`);
  }
}

export function validateCompiledCatalogueArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new TypeError('compiled catalogue artifact is required');
  if (artifact.format !== ARTIFACT_FORMAT) throw new Error(`unsupported compiled catalogue format: ${artifact.format || 'missing'}`);
  if (!Number.isFinite(artifact.verifiedAt) || artifact.verifiedAt <= 0) throw new Error('compiled catalogue verifiedAt is invalid');
  requireText(artifact.sources?.tcgdex?.commit, 'sources.tcgdex.commit');
  requireText(artifact.sources?.pokemonTcg?.commit, 'sources.pokemonTcg.commit');

  const rows = artifact.rows || {};
  const fields = [
    'tcgs',
    'series',
    'sets',
    'setSourceMappings',
    'printings',
    'cardIdentities',
    'cardSourceMappings',
    'cardProvenance',
  ];
  for (const field of fields) {
    const list = requireArray(rows[field], `rows.${field}`);
    countMatches(artifact, field, list);
    assertUniqueIds(list, `rows.${field}`);
  }

  if (rows.sets.length !== Number(artifact.compilation?.verifiedSetCount)) {
    throw new Error('compiled catalogue verified set count does not match persisted set rows');
  }
  if (!rows.sets.length || !rows.cardIdentities.length) throw new Error('compiled catalogue contains no verified rows');
  if (rows.tcgs.some((row) => row.code !== 'pokemon')) throw new Error('bulk loader only accepts the compiled Pokémon catalogue');
  if (rows.series.some((row) => row.verificationStatus !== 'verified')
    || rows.sets.some((row) => row.verificationStatus !== 'verified')
    || rows.printings.some((row) => row.verificationStatus !== 'verified')
    || rows.cardIdentities.some((row) => row.verificationStatus !== 'verified')) {
    throw new Error('compiled catalogue contains non-verified canonical rows');
  }

  for (const row of [...rows.setSourceMappings, ...rows.cardSourceMappings]) {
    const expected = sourceCommit(row.sourceName, artifact);
    if (expected && row.sourceVersion !== expected) {
      throw new Error(`source version mismatch for ${row.sourceName}:${row.sourceRecordId}`);
    }
  }
  for (const row of rows.cardProvenance) {
    const expected = sourceCommit(row.sourceName, artifact);
    if (expected && row.evidenceJson?.sourceCommit !== expected) {
      throw new Error(`provenance source commit mismatch for ${row.sourceName}:${row.sourceRecordId}`);
    }
  }

  return Object.freeze({
    format: artifact.format,
    verifiedAt: artifact.verifiedAt,
    sourceCommits: Object.freeze({
      tcgdex: artifact.sources.tcgdex.commit,
      pokemonTcg: artifact.sources.pokemonTcg.commit,
    }),
    compilation: Object.freeze({
      verifiedSetCount: artifact.compilation.verifiedSetCount,
      rejectedSetCount: artifact.compilation.rejectedSetCount,
    }),
    counts: Object.freeze({ ...artifact.counts }),
  });
}

function chunkRows(rows, size = DEFAULT_CHUNK_SIZE) {
  const safeSize = Math.max(100, Math.min(5000, Number(size) || DEFAULT_CHUNK_SIZE));
  const chunks = [];
  for (let i = 0; i < rows.length; i += safeSize) chunks.push(rows.slice(i, i + safeSize));
  return chunks;
}

async function runChunks(client, rows, sql, chunkSize, counters, key) {
  for (const chunk of chunkRows(rows, chunkSize)) {
    const result = await client.query(sql, [JSON.stringify(chunk)]);
    counters[key] += result.rowCount || 0;
  }
}

const SQL = Object.freeze({
  tcgs: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, code text, name text, status text, "createdAt" bigint, "updatedAt" bigint
    )
  )
  INSERT INTO fatedrop_tcgs (id,code,name,status,created_at,updated_at)
  SELECT id,code,name,status,"createdAt","updatedAt" FROM incoming
  ON CONFLICT (id) DO UPDATE SET
    name=EXCLUDED.name,
    status=EXCLUDED.status,
    updated_at=GREATEST(fatedrop_tcgs.updated_at,EXCLUDED.updated_at)`,

  series: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "tcgId" text, code text, name text, "createdAt" bigint, "updatedAt" bigint,
      "verificationStatus" text, "verifiedAt" bigint
    )
  )
  INSERT INTO fatedrop_card_series (id,tcg_id,code,name,created_at,updated_at,verification_status,verified_at)
  SELECT id,"tcgId",code,name,"createdAt","updatedAt","verificationStatus","verifiedAt" FROM incoming
  ON CONFLICT (id) DO UPDATE SET
    name=EXCLUDED.name,
    verification_status=EXCLUDED.verification_status,
    verified_at=EXCLUDED.verified_at,
    updated_at=GREATEST(fatedrop_card_series.updated_at,EXCLUDED.updated_at)`,

  sets: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "tcgId" text, "seriesId" text, code text, name text,
      "printedTotal" integer, total integer, "releasedAt" bigint,
      "createdAt" bigint, "updatedAt" bigint, "verificationStatus" text, "verifiedAt" bigint
    )
  )
  INSERT INTO fatedrop_card_sets
    (id,tcg_id,series_id,code,name,printed_total,total,released_at,created_at,updated_at,verification_status,verified_at)
  SELECT id,"tcgId","seriesId",code,name,"printedTotal",total,"releasedAt","createdAt","updatedAt","verificationStatus","verifiedAt" FROM incoming
  ON CONFLICT (id) DO UPDATE SET
    name=EXCLUDED.name,
    printed_total=EXCLUDED.printed_total,
    total=EXCLUDED.total,
    released_at=EXCLUDED.released_at,
    verification_status=EXCLUDED.verification_status,
    verified_at=EXCLUDED.verified_at,
    updated_at=GREATEST(fatedrop_card_sets.updated_at,EXCLUDED.updated_at)`,

  setMappingConflict: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "setId" text, "sourceName" text, "sourceRecordId" text
    )
  )
  SELECT i."sourceName",i."sourceRecordId",m.set_id AS existing_set_id,i."setId" AS incoming_set_id
  FROM incoming i
  JOIN fatedrop_card_set_source_mappings m
    ON m.source_name=i."sourceName" AND m.source_record_id=i."sourceRecordId"
  WHERE m.set_id<>i."setId"
  LIMIT 1`,

  setSourceMappings: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "setId" text, "sourceName" text, "sourceRecordId" text,
      "sourceSeriesCode" text, "sourceUrl" text, "sourceVersion" text,
      "firstObservedAt" bigint, "lastObservedAt" bigint
    )
  )
  INSERT INTO fatedrop_card_set_source_mappings
    (id,set_id,source_name,source_record_id,source_series_code,source_url,source_version,first_observed_at,last_observed_at)
  SELECT id,"setId","sourceName","sourceRecordId","sourceSeriesCode","sourceUrl","sourceVersion","firstObservedAt","lastObservedAt" FROM incoming
  ON CONFLICT (source_name,source_record_id) DO UPDATE SET
    source_series_code=COALESCE(EXCLUDED.source_series_code,fatedrop_card_set_source_mappings.source_series_code),
    source_url=COALESCE(EXCLUDED.source_url,fatedrop_card_set_source_mappings.source_url),
    source_version=COALESCE(EXCLUDED.source_version,fatedrop_card_set_source_mappings.source_version),
    last_observed_at=GREATEST(fatedrop_card_set_source_mappings.last_observed_at,EXCLUDED.last_observed_at)`,

  printings: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "tcgId" text, "seriesId" text, "setId" text, "printingCode" text,
      "collectorNumber" text, name text, rarity text, supertype text,
      subtypes jsonb, "nationalDexNumbers" jsonb, attributes jsonb,
      "createdAt" bigint, "updatedAt" bigint, "verificationStatus" text, "verifiedAt" bigint
    )
  )
  INSERT INTO fatedrop_card_printings
    (id,tcg_id,series_id,set_id,printing_code,collector_number,name,rarity,supertype,subtypes,national_dex_numbers,attributes,created_at,updated_at,verification_status,verified_at)
  SELECT id,"tcgId","seriesId","setId","printingCode","collectorNumber",name,rarity,supertype,subtypes,"nationalDexNumbers",attributes,"createdAt","updatedAt","verificationStatus","verifiedAt" FROM incoming
  ON CONFLICT (id) DO UPDATE SET
    name=EXCLUDED.name,
    rarity=COALESCE(EXCLUDED.rarity,fatedrop_card_printings.rarity),
    supertype=COALESCE(EXCLUDED.supertype,fatedrop_card_printings.supertype),
    verification_status=EXCLUDED.verification_status,
    verified_at=EXCLUDED.verified_at,
    updated_at=GREATEST(fatedrop_card_printings.updated_at,EXCLUDED.updated_at)`,

  cardIdentities: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "canonicalKey" text, "tcgId" text, "seriesId" text, "setId" text,
      "printingId" text, "collectorNumber" text, "variantCode" text, "languageCode" text,
      "verificationStatus" text, "verifiedAt" bigint, "createdAt" bigint, "updatedAt" bigint
    )
  )
  INSERT INTO fatedrop_card_identities
    (id,canonical_key,tcg_id,series_id,set_id,printing_id,collector_number,variant_code,language_code,verification_status,verified_at,created_at,updated_at)
  SELECT id,"canonicalKey","tcgId","seriesId","setId","printingId","collectorNumber","variantCode","languageCode","verificationStatus","verifiedAt","createdAt","updatedAt" FROM incoming
  ON CONFLICT (id) DO UPDATE SET
    verification_status=EXCLUDED.verification_status,
    verified_at=EXCLUDED.verified_at,
    updated_at=GREATEST(fatedrop_card_identities.updated_at,EXCLUDED.updated_at)`,

  cardMappingConflict: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "cardIdentityId" text, "sourceName" text, "sourceRecordId" text, "sourceVariantKey" text
    )
  )
  SELECT i."sourceName",i."sourceRecordId",i."sourceVariantKey",
         m.card_identity_id AS existing_card_identity_id,i."cardIdentityId" AS incoming_card_identity_id
  FROM incoming i
  JOIN fatedrop_card_source_mappings m
    ON m.source_name=i."sourceName"
   AND m.source_record_id=i."sourceRecordId"
   AND m.source_variant_key=i."sourceVariantKey"
  WHERE m.card_identity_id<>i."cardIdentityId"
  LIMIT 1`,

  cardSourceMappings: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "cardIdentityId" text, "sourceName" text, "sourceRecordId" text, "sourceVariantKey" text,
      "sourceUrl" text, "sourceVersion" text, "firstObservedAt" bigint, "lastObservedAt" bigint
    )
  )
  INSERT INTO fatedrop_card_source_mappings
    (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,first_observed_at,last_observed_at)
  SELECT id,"cardIdentityId","sourceName","sourceRecordId","sourceVariantKey","sourceUrl","sourceVersion","firstObservedAt","lastObservedAt" FROM incoming
  ON CONFLICT (source_name,source_record_id,source_variant_key) DO UPDATE SET
    source_url=COALESCE(EXCLUDED.source_url,fatedrop_card_source_mappings.source_url),
    source_version=COALESCE(EXCLUDED.source_version,fatedrop_card_source_mappings.source_version),
    last_observed_at=GREATEST(fatedrop_card_source_mappings.last_observed_at,EXCLUDED.last_observed_at)`,

  cardProvenance: `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, "cardIdentityId" text, "sourceName" text, "sourceRecordId" text, "sourceVariantKey" text,
      "sourceUrl" text, "observedAt" bigint, "evidenceStatus" text, "evidenceJson" jsonb, "createdAt" bigint
    )
  )
  INSERT INTO fatedrop_card_provenance
    (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,observed_at,evidence_status,evidence_json,created_at)
  SELECT id,"cardIdentityId","sourceName","sourceRecordId","sourceVariantKey","sourceUrl","observedAt","evidenceStatus","evidenceJson","createdAt" FROM incoming
  ON CONFLICT (id) DO UPDATE SET
    source_url=COALESCE(EXCLUDED.source_url,fatedrop_card_provenance.source_url),
    observed_at=GREATEST(fatedrop_card_provenance.observed_at,EXCLUDED.observed_at),
    evidence_status=EXCLUDED.evidence_status,
    evidence_json=EXCLUDED.evidence_json`,
});

async function assertNoMappingConflicts(client, rows, sql, chunkSize, label) {
  for (const chunk of chunkRows(rows, chunkSize)) {
    const result = await client.query(sql, [JSON.stringify(chunk)]);
    if (result.rows?.[0]) {
      const detail = result.rows[0];
      throw new Error(`${label} conflict: ${JSON.stringify(detail)}`);
    }
  }
}

export async function loadCompiledCatalogueArtifact({ store, artifact, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const summary = validateCompiledCatalogueArtifact(artifact);
  if (typeof store?.pool !== 'function') throw new TypeError('Postgres store is required for compiled catalogue bulk loading');
  const pool = await store.pool();
  const client = await pool.connect();
  const counters = {
    tcgs: 0,
    series: 0,
    sets: 0,
    setSourceMappings: 0,
    printings: 0,
    cardIdentities: 0,
    cardSourceMappings: 0,
    cardProvenance: 0,
  };

  try {
    await client.query('BEGIN');
    await assertNoMappingConflicts(client, artifact.rows.setSourceMappings, SQL.setMappingConflict, chunkSize, 'set source mapping');
    await assertNoMappingConflicts(client, artifact.rows.cardSourceMappings, SQL.cardMappingConflict, chunkSize, 'card source mapping');

    await runChunks(client, artifact.rows.tcgs, SQL.tcgs, chunkSize, counters, 'tcgs');
    await runChunks(client, artifact.rows.series, SQL.series, chunkSize, counters, 'series');
    await runChunks(client, artifact.rows.sets, SQL.sets, chunkSize, counters, 'sets');
    await runChunks(client, artifact.rows.setSourceMappings, SQL.setSourceMappings, chunkSize, counters, 'setSourceMappings');
    await runChunks(client, artifact.rows.printings, SQL.printings, chunkSize, counters, 'printings');
    await runChunks(client, artifact.rows.cardIdentities, SQL.cardIdentities, chunkSize, counters, 'cardIdentities');
    await runChunks(client, artifact.rows.cardSourceMappings, SQL.cardSourceMappings, chunkSize, counters, 'cardSourceMappings');
    await runChunks(client, artifact.rows.cardProvenance, SQL.cardProvenance, chunkSize, counters, 'cardProvenance');

    await client.query('COMMIT');
    return Object.freeze({ status: 'complete', summary, affectedRows: Object.freeze(counters) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
