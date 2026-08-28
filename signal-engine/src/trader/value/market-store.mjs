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
    const lab = fileValueLab(state);
    const { run, observations, rejections } = batch;

    const existingRun = lab.ingestRuns[run.id];
    if (existingRun
      && (existingRun.sourceName !== run.sourceName
        || existingRun.sourceSnapshotId !== run.sourceSnapshotId)) {
      throw new Error('Market ingest run identity conflict');
    }
    lab.ingestRuns[run.id] = run;

    let insertedObservations = 0;
    let duplicateObservations = 0;
    for (const observation of observations) {
      assertFileMapping(state, observation);
      const existing = lab.observations[observation.id];
      if (existing) {
        if (existing.contentFingerprint !== observation.contentFingerprint) {
          throw new Error('Immutable market observation conflict');
        }
        duplicateObservations += 1;
        continue;
      }
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

async function assertPostgresMapping(client, observation) {
  const { rows } = await client.query(
    `SELECT m.card_identity_id,m.source_name,m.source_record_id,m.source_variant_key,
            c.verification_status
       FROM fatedrop_card_source_mappings m
       JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
      WHERE m.id=$1`,
    [observation.cardSourceMappingId],
  );
  const mapping = rows[0];
  if (!mapping) throw new Error('Market observation requires a canonical card source mapping');
  if (mapping.verification_status !== 'verified') {
    throw new Error('Market observation requires a verified canonical card identity');
  }
  if (mapping.card_identity_id !== observation.cardIdentityId
    || mapping.source_name !== observation.sourceName
    || mapping.source_record_id !== observation.sourceRecordId
    || mapping.source_variant_key !== observation.sourceVariantKey) {
    throw new Error('Market observation card source mapping mismatch');
  }
}

async function persistPostgres(store, batch) {
  const pool = await store.pool();
  const client = await pool.connect();
  const { run, observations, rejections } = batch;

  try {
    await client.query('BEGIN');

    await client.query(`INSERT INTO fatedrop_market_ingest_runs (
        id,source_name,source_snapshot_id,source_version,started_at,completed_at,status,
        records_seen,records_accepted,records_rejected,metadata_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      ON CONFLICT (id) DO UPDATE SET
        source_version=COALESCE(EXCLUDED.source_version,fatedrop_market_ingest_runs.source_version),
        completed_at=EXCLUDED.completed_at,
        status=EXCLUDED.status,
        records_seen=EXCLUDED.records_seen,
        records_accepted=EXCLUDED.records_accepted,
        records_rejected=EXCLUDED.records_rejected,
        metadata_json=EXCLUDED.metadata_json`, [
      run.id,
      run.sourceName,
      run.sourceSnapshotId,
      run.sourceVersion,
      run.startedAt,
      run.completedAt,
      run.status,
      run.recordsSeen,
      run.recordsAccepted,
      run.recordsRejected,
      JSON.stringify(run.metadataJson),
      run.createdAt,
    ]);

    let insertedObservations = 0;
    let duplicateObservations = 0;
    for (const observation of observations) {
      await assertPostgresMapping(client, observation);
      const existing = await client.query(
        'SELECT content_fingerprint FROM fatedrop_market_observations WHERE id=$1',
        [observation.id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].content_fingerprint !== observation.contentFingerprint) {
          throw new Error('Immutable market observation conflict');
        }
        duplicateObservations += 1;
        continue;
      }

      await client.query(`INSERT INTO fatedrop_market_observations (
          id,ingest_run_id,card_identity_id,card_source_mapping_id,source_name,
          source_snapshot_id,source_record_id,source_variant_key,market_segment_key,
          condition_code,currency_code,observed_at,source_effective_at,market_day,
          market_price,low_price,trend_price,avg_1d,avg_7d,avg_30d,avg_lifetime,
          excellent_plus_low,metrics_json,raw_payload,content_fingerprint,created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,
          $15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25,$26
        )`, [
        observation.id,
        observation.ingestRunId,
        observation.cardIdentityId,
        observation.cardSourceMappingId,
        observation.sourceName,
        observation.sourceSnapshotId,
        observation.sourceRecordId,
        observation.sourceVariantKey,
        observation.marketSegmentKey,
        observation.conditionCode,
        observation.currencyCode,
        observation.observedAt,
        observation.sourceEffectiveAt,
        observation.marketDay,
        observation.marketPrice,
        observation.lowPrice,
        observation.trendPrice,
        observation.avg1d,
        observation.avg7d,
        observation.avg30d,
        observation.avgLifetime,
        observation.excellentPlusLow,
        JSON.stringify(observation.metricsJson),
        JSON.stringify(observation.rawPayload),
        observation.contentFingerprint,
        observation.createdAt,
      ]);
      insertedObservations += 1;
    }

    let insertedRejections = 0;
    for (const rejection of rejections) {
      const result = await client.query(`INSERT INTO fatedrop_market_ingest_rejections (
          id,ingest_run_id,source_name,source_snapshot_id,source_record_id,
          source_variant_key,rejection_code,rejection_detail,raw_payload,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        ON CONFLICT (id) DO NOTHING`, [
        rejection.id,
        rejection.ingestRunId,
        rejection.sourceName,
        rejection.sourceSnapshotId,
        rejection.sourceRecordId,
        rejection.sourceVariantKey,
        rejection.rejectionCode,
        rejection.rejectionDetail,
        JSON.stringify(rejection.rawPayload),
        rejection.createdAt,
      ]);
      insertedRejections += result.rowCount || 0;
    }

    await client.query('COMMIT');
    return {
      insertedObservations,
      duplicateObservations,
      insertedRejections,
    };
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
