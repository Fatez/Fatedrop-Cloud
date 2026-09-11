function fileValueLab(state) {
  state.fateValueLab ||= {
    ingestRuns: {},
    observations: {},
    rejections: {},
  };
  return state.fateValueLab;
}

function assertBatch(run, observations, rejections) {
  if (!run || typeof run !== 'object') throw new TypeError('market ingest run is required');
  if (!Array.isArray(observations)) throw new TypeError('market observations must be an array');
  if (!Array.isArray(rejections)) throw new TypeError('market rejections must be an array');

  if (run.recordsSeen !== observations.length + rejections.length
    || run.recordsAccepted !== observations.length
    || run.recordsRejected !== rejections.length) {
    throw new TypeError('market ingest counts must match the persisted batch');
  }
  if (run.status === 'running') throw new TypeError('persisted market batches must be terminal');

  for (const observation of observations) {
    if (observation.ingestRunId !== run.id
      || observation.sourceName !== run.sourceName
      || observation.sourceSnapshotId !== run.sourceSnapshotId) {
      throw new TypeError('market observation does not belong to ingest run');
    }
  }
  for (const rejection of rejections) {
    if (rejection.ingestRunId !== run.id
      || rejection.sourceName !== run.sourceName
      || rejection.sourceSnapshotId !== run.sourceSnapshotId) {
      throw new TypeError('market rejection does not belong to ingest run');
    }
  }
}

function fileCardIdentity(state, cardIdentityId) {
  const cards = state.traderCatalogue?.cards || {};
  return cards[cardIdentityId]
    ?? Object.values(cards).find((candidate) => candidate?.id === cardIdentityId)
    ?? null;
}

function assertFileMapping(state, observation) {
  const mappings = Object.values(state.traderCatalogue?.cardSourceMappings || {});
  const mapping = mappings.find((candidate) => candidate.id === observation.cardSourceMappingId);
  if (!mapping) throw new Error('Market observation requires a canonical card source mapping');

  const card = fileCardIdentity(state, observation.cardIdentityId);
  if (!card || card.verificationStatus !== 'verified') {
    throw new Error('Market observation requires a verified canonical card identity');
  }

  if (mapping.cardIdentityId !== observation.cardIdentityId
    || mapping.sourceName !== observation.sourceName
    || mapping.sourceRecordId !== observation.sourceRecordId
    || mapping.sourceVariantKey !== observation.sourceVariantKey) {
    throw new Error('Market observation card source mapping mismatch');
  }
}

async function persistFile(store, batch) {
  return store.mutate((state) => {
    const { run, observations, rejections } = batch;

    // Validate every canonical relationship before creating or mutating any
    // Fate Value state. File-backed stores are not assumed to be transactional,
    // so a rejected observation must leave no partial ingest-run residue behind.
    for (const observation of observations) assertFileMapping(state, observation);

    const lab = fileValueLab(state);
    const existingRun = lab.ingestRuns[run.id];
    if (existingRun
      && (existingRun.sourceName !== run.sourceName
        || existingRun.sourceSnapshotId !== run.sourceSnapshotId)) {
      throw new Error('Market ingest run identity conflict');
    }

    let insertedObservations = 0;
    let duplicateObservations = 0;
    for (const observation of observations) {
      const existing = lab.observations[observation.id];
      if (existing) {
        if (existing.contentFingerprint !== observation.contentFingerprint) {
          throw new Error('Immutable market observation conflict');
        }
        duplicateObservations += 1;
      }
    }

    // Only after all fail-closed validation succeeds do we mutate the file state.
    lab.ingestRuns[run.id] = run;
    for (const observation of observations) {
      if (lab.observations[observation.id]) continue;
      lab.observations[observation.id] = observation;
      insertedObservations += 1;
    }

    let insertedRejections = 0;
    for (const rejection of rejections) {
      if (!lab.rejections[rejection.id]) {
        lab.rejections[rejection.id] = rejection;
        insertedRejections += 1;
      }
    }

    return {
      insertedObservations,
      duplicateObservations,
      insertedRejections,
    };
  });
}

function postgresObservationPayload(observations) {
  const seen = new Set();
  return observations.map((observation) => {
    if (seen.has(observation.id)) throw new Error('Duplicate market observation id in batch');
    seen.add(observation.id);
    return {
      id: observation.id, ingest_run_id: observation.ingestRunId, card_identity_id: observation.cardIdentityId,
      card_source_mapping_id: observation.cardSourceMappingId, source_name: observation.sourceName,
      source_snapshot_id: observation.sourceSnapshotId, source_record_id: observation.sourceRecordId,
      source_variant_key: observation.sourceVariantKey, market_segment_key: observation.marketSegmentKey,
      condition_code: observation.conditionCode, currency_code: observation.currencyCode,
      observed_at: observation.observedAt, source_effective_at: observation.sourceEffectiveAt, market_day: observation.marketDay,
      market_price: observation.marketPrice, low_price: observation.lowPrice, trend_price: observation.trendPrice,
      avg_1d: observation.avg1d, avg_7d: observation.avg7d, avg_30d: observation.avg30d, avg_lifetime: observation.avgLifetime,
      excellent_plus_low: observation.excellentPlusLow, metrics_json: observation.metricsJson, raw_payload: observation.rawPayload,
      content_fingerprint: observation.contentFingerprint, created_at: observation.createdAt,
    };
  });
}

function postgresRejectionPayload(rejections) {
  const seen = new Set();
  return rejections.map((rejection) => {
    if (seen.has(rejection.id)) throw new Error('Duplicate market rejection id in batch');
    seen.add(rejection.id);
    return {
      id: rejection.id, ingest_run_id: rejection.ingestRunId, source_name: rejection.sourceName,
      source_snapshot_id: rejection.sourceSnapshotId, source_record_id: rejection.sourceRecordId,
      source_variant_key: rejection.sourceVariantKey, rejection_code: rejection.rejectionCode,
      rejection_detail: rejection.rejectionDetail, raw_payload: rejection.rawPayload, created_at: rejection.createdAt,
    };
  });
}

async function validatePostgresObservations(client, payload) {
  if (!payload.length) return;
  const json = JSON.stringify(payload);
  const { rows: mappingConflicts } = await client.query(
    `WITH incoming AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
         id text, card_identity_id text, card_source_mapping_id text, source_name text,
         source_record_id text, source_variant_key text)
     )
     SELECT i.id
     FROM incoming i
     LEFT JOIN fatedrop_card_source_mappings m ON m.id=i.card_source_mapping_id
     LEFT JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
     WHERE m.id IS NULL
        OR c.verification_status IS DISTINCT FROM 'verified'
        OR m.card_identity_id IS DISTINCT FROM i.card_identity_id
        OR m.source_name IS DISTINCT FROM i.source_name
        OR m.source_record_id IS DISTINCT FROM i.source_record_id
        OR m.source_variant_key IS DISTINCT FROM i.source_variant_key
     LIMIT 1`, [json]);
  if (mappingConflicts.length) throw new Error('Market observation card source mapping mismatch');

  const { rows: fingerprintConflicts } = await client.query(
    `WITH incoming AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(id text, content_fingerprint text)
     )
     SELECT i.id
     FROM incoming i
     JOIN fatedrop_market_observations o ON o.id=i.id
     WHERE o.content_fingerprint IS DISTINCT FROM i.content_fingerprint
     LIMIT 1`, [json]);
  if (fingerprintConflicts.length) throw new Error('Immutable market observation conflict');
}

async function persistPostgres(store, batch) {
  const pool = await store.pool();
  const client = await pool.connect();
  const { run, observations, rejections } = batch;
  const observationPayload = postgresObservationPayload(observations);
  const rejectionPayload = postgresRejectionPayload(rejections);
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO fatedrop_market_ingest_runs (
        id,source_name,source_snapshot_id,source_version,started_at,completed_at,status,
        records_seen,records_accepted,records_rejected,metadata_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      ON CONFLICT (id) DO UPDATE SET
        source_version=COALESCE(EXCLUDED.source_version,fatedrop_market_ingest_runs.source_version),
        completed_at=EXCLUDED.completed_at,status=EXCLUDED.status,records_seen=EXCLUDED.records_seen,
        records_accepted=EXCLUDED.records_accepted,records_rejected=EXCLUDED.records_rejected,
        metadata_json=EXCLUDED.metadata_json`, [
      run.id,run.sourceName,run.sourceSnapshotId,run.sourceVersion,run.startedAt,run.completedAt,run.status,
      run.recordsSeen,run.recordsAccepted,run.recordsRejected,JSON.stringify(run.metadataJson),run.createdAt,
    ]);

    await validatePostgresObservations(client, observationPayload);

    let insertedObservations = 0;
    if (observationPayload.length) {
      const inserted = await client.query(`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
          id text, ingest_run_id text, card_identity_id text, card_source_mapping_id text, source_name text,
          source_snapshot_id text, source_record_id text, source_variant_key text, market_segment_key text,
          condition_code text, currency_code text, observed_at bigint, source_effective_at bigint, market_day date,
          market_price numeric, low_price numeric, trend_price numeric, avg_1d numeric, avg_7d numeric, avg_30d numeric,
          avg_lifetime numeric, excellent_plus_low numeric, metrics_json jsonb, raw_payload jsonb,
          content_fingerprint text, created_at bigint)
      )
      INSERT INTO fatedrop_market_observations (
        id,ingest_run_id,card_identity_id,card_source_mapping_id,source_name,source_snapshot_id,source_record_id,
        source_variant_key,market_segment_key,condition_code,currency_code,observed_at,source_effective_at,market_day,
        market_price,low_price,trend_price,avg_1d,avg_7d,avg_30d,avg_lifetime,excellent_plus_low,metrics_json,raw_payload,
        content_fingerprint,created_at)
      SELECT id,ingest_run_id,card_identity_id,card_source_mapping_id,source_name,source_snapshot_id,source_record_id,
        source_variant_key,market_segment_key,condition_code,currency_code,observed_at,source_effective_at,market_day,
        market_price,low_price,trend_price,avg_1d,avg_7d,avg_30d,avg_lifetime,excellent_plus_low,metrics_json,raw_payload,
        content_fingerprint,created_at FROM incoming
      ON CONFLICT (id) DO NOTHING RETURNING id`, [JSON.stringify(observationPayload)]);
      insertedObservations = inserted.rowCount || 0;
    }
    const duplicateObservations = observationPayload.length - insertedObservations;

    let insertedRejections = 0;
    if (rejectionPayload.length) {
      const inserted = await client.query(`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
          id text, ingest_run_id text, source_name text, source_snapshot_id text, source_record_id text,
          source_variant_key text, rejection_code text, rejection_detail text, raw_payload jsonb, created_at bigint)
      )
      INSERT INTO fatedrop_market_ingest_rejections (
        id,ingest_run_id,source_name,source_snapshot_id,source_record_id,source_variant_key,rejection_code,rejection_detail,raw_payload,created_at)
      SELECT id,ingest_run_id,source_name,source_snapshot_id,source_record_id,source_variant_key,rejection_code,rejection_detail,raw_payload,created_at
      FROM incoming ON CONFLICT (id) DO NOTHING RETURNING id`, [JSON.stringify(rejectionPayload)]);
      insertedRejections = inserted.rowCount || 0;
    }

    await client.query('COMMIT');
    return { insertedObservations, duplicateObservations, insertedRejections };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function persistMarketEvidenceBatch(
  store,
  { run, observations = [], rejections = [] },
) {
  assertBatch(run, observations, rejections);
  const batch = { run, observations, rejections };
  if (typeof store?.mutate === 'function') return persistFile(store, batch);
  if (typeof store?.pool === 'function') return persistPostgres(store, batch);
  throw new Error('Fate Value market persistence is unavailable');
}
