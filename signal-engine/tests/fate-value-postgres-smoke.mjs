import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

import {
  normaliseMarketIngestRejection,
  normaliseMarketIngestRun,
  normaliseMarketObservationCandidate,
} from '../src/trader/value/market-observation.mjs';
import { persistMarketEvidenceBatch } from '../src/trader/value/market-store.mjs';
import { persistCanonicalSignals } from '../src/stores/canonical-signal-ledger.mjs';

const connectionString = process.env.FATE_VALUE_TEST_DATABASE_URL;
if (!connectionString) throw new Error('FATE_VALUE_TEST_DATABASE_URL is required');

const NOW = Date.parse('2026-08-28T00:00:00.000Z');
const SOURCE = 'cardmarket';
const VERIFIED_CARD_ID = 'fdcard_value_smoke_verified';
const VERIFIED_MAPPING_ID = 'fdcardmap_value_smoke_verified';
const STAGED_CARD_ID = 'fdcard_value_smoke_staged';
const STAGED_MAPPING_ID = 'fdcardmap_value_smoke_staged';
const EPISODE_PRODUCT_ID = 'fdproduct_episode_smoke';
const EPISODE_OFFER_ID = 'fdoffer_episode_smoke';

function completedRun(snapshotId, { accepted = 1, rejected = 0, offset = 0 } = {}) {
  return normaliseMarketIngestRun({
    sourceName: SOURCE,
    sourceSnapshotId: snapshotId,
    sourceVersion: '1',
    startedAt: NOW + offset - 1_000,
    completedAt: NOW + offset,
    status: rejected > 0 ? 'partial' : 'completed',
    recordsSeen: accepted + rejected,
    recordsAccepted: accepted,
    recordsRejected: rejected,
  });
}

function verifiedObservation(run, overrides = {}) {
  return normaliseMarketObservationCandidate({
    ingestRunId: run.id,
    cardIdentityId: VERIFIED_CARD_ID,
    cardSourceMappingId: VERIFIED_MAPPING_ID,
    sourceName: SOURCE,
    sourceSnapshotId: run.sourceSnapshotId,
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
    currencyCode: 'EUR',
    observedAt: NOW,
    sourceEffectiveAt: NOW,
    marketPrice: 8.93,
    lowPrice: 5,
    trendPrice: 11.25,
    avg1d: 8.45,
    avg7d: 8.8,
    avg30d: 9.39,
    rawPayload: { idProduct: 668227, avg: 8.93, avg7: 8.8 },
    ...overrides,
  });
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function episodeSignal(state, offset) {
  const detectedAt = Math.floor(NOW / 1_000) + offset;
  return {
    id: `fdsignal_episode_${state}`,
    state,
    productId: EPISODE_PRODUCT_ID,
    offerId: EPISODE_OFFER_ID,
    retailerId: 'episode-smoke-retailer',
    retailerName: 'Episode Smoke Retailer',
    title: 'Episode Smoke Booster Pack',
    productType: 'booster_pack',
    url: 'https://example.com/episode-smoke',
    pricePence: 499,
    stockStatus: state === 'vanished' ? 'out_of_stock' : state === 'manifested' ? 'in_stock' : 'unknown',
    confidence: 0.99,
    detectedAt,
    reason: 'postgres_smoke',
    evidence: [{ kind: 'signal_kind', value: 'postgres_smoke' }],
  };
}

const pool = new Pool({ connectionString, max: 2 });
const store = { pool: async () => pool };

try {
  const baseSql = await readFile(
    new URL('../database/postgres.sql', import.meta.url),
    'utf8',
  );
  const episodeSql = await readFile(
    new URL('../database/canonical-stock-episodes.sql', import.meta.url),
    'utf8',
  );
  const identitySql = await readFile(
    new URL('../database/fate-trader-card-identity.sql', import.meta.url),
    'utf8',
  );
  const valueSql = await readFile(
    new URL('../database/fate-value-market-history.sql', import.meta.url),
    'utf8',
  );

  await pool.query(baseSql);
  await pool.query(episodeSql);
  await pool.query(identitySql);
  await pool.query(valueSql);

  await pool.query(`INSERT INTO fatedrop_tcgs (id,code,name,created_at,updated_at)
    VALUES ('fdtcg_pokemon','pokemon','Pokémon', $1, $1)`, [NOW]);
  await pool.query(`INSERT INTO fatedrop_card_series (id,tcg_id,code,name,created_at,updated_at)
    VALUES ('fdseries_smoke','fdtcg_pokemon','smoke-series','Smoke Series', $1, $1)`, [NOW]);
  await pool.query(`INSERT INTO fatedrop_card_sets (id,tcg_id,series_id,code,name,created_at,updated_at)
    VALUES ('fdset_smoke','fdtcg_pokemon','fdseries_smoke','smoke-set','Smoke Set', $1, $1)`, [NOW]);

  await pool.query(`INSERT INTO fatedrop_card_printings (
      id,tcg_id,series_id,set_id,printing_code,collector_number,name,created_at,updated_at
    ) VALUES
      ('fdprinting_smoke_verified','fdtcg_pokemon','fdseries_smoke','fdset_smoke','main','161','Verified Test Card',$1,$1),
      ('fdprinting_smoke_staged','fdtcg_pokemon','fdseries_smoke','fdset_smoke','main','162','Staged Test Card',$1,$1)`, [NOW]);

  await pool.query(`INSERT INTO fatedrop_card_identities (
      id,canonical_key,tcg_id,series_id,set_id,printing_id,collector_number,
      variant_code,language_code,verification_status,verified_at,created_at,updated_at
    ) VALUES
      ($1,'pokemon|smoke|161|main|standard|en','fdtcg_pokemon','fdseries_smoke','fdset_smoke',
       'fdprinting_smoke_verified','161','standard','en','verified',$3,$3,$3),
      ($2,'pokemon|smoke|162|main|standard|en','fdtcg_pokemon','fdseries_smoke','fdset_smoke',
       'fdprinting_smoke_staged','162','standard','en','staged',NULL,$3,$3)`,
  [VERIFIED_CARD_ID, STAGED_CARD_ID, NOW]);

  await pool.query(`INSERT INTO fatedrop_card_source_mappings (
      id,card_identity_id,source_name,source_record_id,source_variant_key,
      source_version,first_observed_at,last_observed_at
    ) VALUES
      ($1,$2,'cardmarket','668227','normal','1',$5,$5),
      ($3,$4,'cardmarket','668228','normal','1',$5,$5)`,
  [VERIFIED_MAPPING_ID, VERIFIED_CARD_ID, STAGED_MAPPING_ID, STAGED_CARD_ID, NOW]);

  const run = completedRun('price-guide-2026-08-28');
  const observation = verifiedObservation(run);
  const first = await persistMarketEvidenceBatch(store, {
    run,
    observations: [observation],
    rejections: [],
  });
  assert.deepEqual(first, {
    insertedObservations: 1,
    duplicateObservations: 0,
    insertedRejections: 0,
  });

  const replay = verifiedObservation(run, { observedAt: NOW + 60_000 });
  const replayResult = await persistMarketEvidenceBatch(store, {
    run,
    observations: [replay],
    rejections: [],
  });
  assert.deepEqual(replayResult, {
    insertedObservations: 0,
    duplicateObservations: 1,
    insertedRejections: 0,
  });

  await assert.rejects(
    persistMarketEvidenceBatch(store, {
      run,
      observations: [verifiedObservation(run, { avg7d: 9.1 })],
      rejections: [],
    }),
    /Immutable market observation conflict/,
  );

  const stagedRun = completedRun('price-guide-2026-08-29', { offset: 86_400_000 });
  const stagedObservation = normaliseMarketObservationCandidate({
    ingestRunId: stagedRun.id,
    cardIdentityId: STAGED_CARD_ID,
    cardSourceMappingId: STAGED_MAPPING_ID,
    sourceName: SOURCE,
    sourceSnapshotId: stagedRun.sourceSnapshotId,
    sourceRecordId: '668228',
    sourceVariantKey: 'normal',
    currencyCode: 'EUR',
    observedAt: NOW + 86_400_000,
    sourceEffectiveAt: NOW + 86_400_000,
    avg7d: 4.2,
    rawPayload: { idProduct: 668228, avg7: 4.2 },
  });
  await assert.rejects(
    persistMarketEvidenceBatch(store, {
      run: stagedRun,
      observations: [stagedObservation],
      rejections: [],
    }),
    /requires a verified canonical card identity/,
  );

  const rejectionRun = completedRun('price-guide-2026-08-30', {
    accepted: 0,
    rejected: 1,
    offset: 172_800_000,
  });
  const rejection = normaliseMarketIngestRejection({
    ingestRunId: rejectionRun.id,
    sourceName: SOURCE,
    sourceSnapshotId: rejectionRun.sourceSnapshotId,
    sourceRecordId: '999999',
    sourceVariantKey: 'normal',
    rejectionCode: 'identity_unresolved',
    rejectionDetail: 'No verified exact FateDrop mapping',
    rawPayload: { idProduct: 999999 },
    createdAt: NOW + 172_800_000,
  });
  const rejectionResult = await persistMarketEvidenceBatch(store, {
    run: rejectionRun,
    observations: [],
    rejections: [rejection],
  });
  assert.equal(rejectionResult.insertedRejections, 1);

  const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM fatedrop_market_observations) AS observations,
      (SELECT COUNT(*)::int FROM fatedrop_market_ingest_rejections) AS rejections,
      (SELECT COUNT(*)::int FROM fatedrop_market_ingest_runs) AS runs`);
  assert.deepEqual(counts.rows[0], { observations: 1, rejections: 1, runs: 2 });

  const persisted = await pool.query(
    'SELECT source_name,currency_code,avg_7d,market_day FROM fatedrop_market_observations WHERE id=$1',
    [observation.id],
  );
  assert.equal(persisted.rows[0].source_name, 'cardmarket');
  assert.equal(persisted.rows[0].currency_code, 'EUR');
  assert.equal(Number(persisted.rows[0].avg_7d), 8.8);
  assert.equal(dateOnly(persisted.rows[0].market_day), '2026-08-28');

  await pool.query(`INSERT INTO fatedrop_products (
      id,canonical_key,title,product_type,first_seen_at,updated_at
    ) VALUES ($1,'episode-smoke-product','Episode Smoke Booster Pack','booster_pack',$2,$2)`,
  [EPISODE_PRODUCT_ID, NOW]);
  await pool.query(`INSERT INTO fatedrop_retail_offers (
      offer_id,product_id,retailer_id,retailer_name,retailer_sku,title,url,
      stock_status,stock_confidence,first_seen_at,last_seen_at
    ) VALUES ($1,$2,'episode-smoke-retailer','Episode Smoke Retailer','episode-smoke-sku',
      'Episode Smoke Booster Pack','https://example.com/episode-smoke','unknown',0.99,$3,$3)`,
  [EPISODE_OFFER_ID, EPISODE_PRODUCT_ID, NOW]);

  const episodeSignals = [
    episodeSignal('whisper', 1),
    episodeSignal('echo', 2),
    episodeSignal('manifested', 3),
    episodeSignal('vanished', 4),
  ];
  const episodeClient = await pool.connect();
  let episodeResult;
  let episodeReplayResult;
  try {
    await episodeClient.query('BEGIN');
    episodeResult = await persistCanonicalSignals(episodeClient, episodeSignals, {
      now: Math.floor(NOW / 1_000) + 10,
    });
    episodeReplayResult = await persistCanonicalSignals(episodeClient, episodeSignals, {
      now: Math.floor(NOW / 1_000) + 11,
    });
    await episodeClient.query('COMMIT');
  } catch (error) {
    await episodeClient.query('ROLLBACK');
    throw error;
  } finally {
    episodeClient.release();
  }

  assert.deepEqual(episodeResult.acceptedSignalIds, episodeSignals.map(({ id }) => id));
  assert.deepEqual(episodeReplayResult.deduplicatedSignalIds, episodeSignals.map(({ id }) => id));
  const episodeCounts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM fatedrop_stock_episodes) AS episodes,
      (SELECT COUNT(*)::int FROM fatedrop_stock_episode_events) AS events,
      (SELECT COUNT(*)::int FROM fatedrop_signal_delivery_outbox) AS outbox,
      (SELECT COUNT(*)::int FROM fatedrop_signal_delivery_outbox WHERE state='pending') AS pending`);
  assert.deepEqual(episodeCounts.rows[0], { episodes: 1, events: 4, outbox: 4, pending: 4 });

  const episodeTruth = await pool.query(`SELECT
      episode_state,availability_state,manifested_at,vanished_at
    FROM fatedrop_stock_episodes WHERE offer_id=$1`, [EPISODE_OFFER_ID]);
  assert.equal(episodeTruth.rows[0].episode_state, 'closed');
  assert.equal(episodeTruth.rows[0].availability_state, 'vanished');
  assert.ok(Number(episodeTruth.rows[0].vanished_at) > Number(episodeTruth.rows[0].manifested_at));

  const orphanClient = await pool.connect();
  let orphanResult;
  try {
    await orphanClient.query('BEGIN');
    orphanResult = await persistCanonicalSignals(
      orphanClient,
      [{ ...episodeSignal('vanished', 5), id: 'fdsignal_episode_orphan_vanished' }],
      { now: Math.floor(NOW / 1_000) + 12 },
    );
    await orphanClient.query('COMMIT');
  } catch (error) {
    await orphanClient.query('ROLLBACK');
    throw error;
  } finally {
    orphanClient.release();
  }
  assert.deepEqual(orphanResult.conflictSignalIds, ['fdsignal_episode_orphan_vanished']);
  const orphanTruth = await pool.query(`SELECT
      EXISTS(SELECT 1 FROM fatedrop_signals WHERE id='fdsignal_episode_orphan_vanished') AS public_signal,
      EXISTS(SELECT 1 FROM fatedrop_stock_episode_conflicts WHERE signal_id='fdsignal_episode_orphan_vanished') AS conflict`);
  assert.deepEqual(orphanTruth.rows[0], { public_signal: false, conflict: true });

  console.log('Fate Value and canonical stock episode PostgreSQL smoke rehearsal passed');
} finally {
  await pool.end();
}
