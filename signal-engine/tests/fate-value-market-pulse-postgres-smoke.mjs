import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { normaliseMarketIngestRun, normaliseMarketObservationCandidate } from '../src/trader/value/market-observation.mjs';
import { persistMarketEvidenceBatch } from '../src/trader/value/market-store.mjs';
import { buildMarketPulseSnapshotFromStore } from '../src/trader/value/market-pulse-data.mjs';
import { buildMarketDataReadinessReport } from '../src/trader/value/market-data-readiness.mjs';

const connectionString = process.env.FATE_VALUE_TEST_DATABASE_URL;
if (!connectionString) throw new Error('FATE_VALUE_TEST_DATABASE_URL is required');

const SOURCE = 'pulse-smoke';
const CARD_ID = 'fdcard_pulse_postgres_smoke';
const MAPPING_ID = 'fdcardmap_pulse_postgres_smoke';
const CURRENT = Date.parse('2026-09-03T00:00:00.000Z');
const BASELINE = Date.parse('2026-08-27T00:00:00.000Z');

function run(snapshotId, timestamp) {
  return normaliseMarketIngestRun({
    sourceName: SOURCE,
    sourceSnapshotId: snapshotId,
    sourceVersion: '1',
    startedAt: timestamp - 1_000,
    completedAt: timestamp,
    status: 'completed',
    recordsSeen: 1,
    recordsAccepted: 1,
    recordsRejected: 0,
  });
}

function observation(ingestRun, timestamp, trendPrice) {
  return normaliseMarketObservationCandidate({
    ingestRunId: ingestRun.id,
    cardIdentityId: CARD_ID,
    cardSourceMappingId: MAPPING_ID,
    sourceName: SOURCE,
    sourceSnapshotId: ingestRun.sourceSnapshotId,
    sourceRecordId: '900001',
    sourceVariantKey: 'normal',
    currencyCode: 'EUR',
    observedAt: timestamp,
    sourceEffectiveAt: timestamp,
    trendPrice,
    rawPayload: { smoke: true, trendPrice },
  });
}

const pool = new Pool({ connectionString, max: 2 });
const store = { pool: async () => pool };

try {
  const identitySql = await readFile(
    new URL('../database/fate-trader-card-identity.sql', import.meta.url),
    'utf8',
  );
  const valueSql = await readFile(
    new URL('../database/fate-value-market-history.sql', import.meta.url),
    'utf8',
  );
  await pool.query(identitySql);
  await pool.query(valueSql);

  await pool.query(`INSERT INTO fatedrop_tcgs (id,code,name,created_at,updated_at)
    VALUES ('fdtcg_pulse_smoke','pulse-smoke-game','Pulse Smoke Game',$1,$1)
    ON CONFLICT (id) DO NOTHING`, [BASELINE]);
  await pool.query(`INSERT INTO fatedrop_card_series (id,tcg_id,code,name,created_at,updated_at)
    VALUES ('fdseries_pulse_smoke','fdtcg_pulse_smoke','pulse-series','Pulse Series',$1,$1)
    ON CONFLICT (id) DO NOTHING`, [BASELINE]);
  await pool.query(`INSERT INTO fatedrop_card_sets (id,tcg_id,series_id,code,name,created_at,updated_at)
    VALUES ('fdset_pulse_smoke','fdtcg_pulse_smoke','fdseries_pulse_smoke','pulse-set','Pulse Set',$1,$1)
    ON CONFLICT (id) DO NOTHING`, [BASELINE]);
  await pool.query(`INSERT INTO fatedrop_card_printings (
      id,tcg_id,series_id,set_id,printing_code,collector_number,name,created_at,updated_at
    ) VALUES ('fdprinting_pulse_smoke','fdtcg_pulse_smoke','fdseries_pulse_smoke','fdset_pulse_smoke',
      'main','1','Pulse Test Card',$1,$1)
    ON CONFLICT (id) DO NOTHING`, [BASELINE]);
  await pool.query(`INSERT INTO fatedrop_card_identities (
      id,canonical_key,tcg_id,series_id,set_id,printing_id,collector_number,
      variant_code,language_code,verification_status,verified_at,created_at,updated_at
    ) VALUES ($1,'pulse|smoke|1|main|normal|en','fdtcg_pulse_smoke','fdseries_pulse_smoke',
      'fdset_pulse_smoke','fdprinting_pulse_smoke','1','normal','en','verified',$2,$2,$2)
    ON CONFLICT (id) DO NOTHING`, [CARD_ID, BASELINE]);
  await pool.query(`INSERT INTO fatedrop_card_source_mappings (
      id,card_identity_id,source_name,source_record_id,source_variant_key,
      source_version,first_observed_at,last_observed_at
    ) VALUES ($1,$2,$3,'900001','normal','1',$4,$5)
    ON CONFLICT (source_name,source_record_id,source_variant_key) DO NOTHING`,
  [MAPPING_ID, CARD_ID, SOURCE, BASELINE, CURRENT]);

  const baselineRun = run('pulse-smoke-2026-08-27', BASELINE);
  const currentRun = run('pulse-smoke-2026-09-03', CURRENT);
  await persistMarketEvidenceBatch(store, {
    run: baselineRun,
    observations: [observation(baselineRun, BASELINE, 100)],
    rejections: [],
  });
  await persistMarketEvidenceBatch(store, {
    run: currentRun,
    observations: [observation(currentRun, CURRENT, 125)],
    rejections: [],
  });

  const pulse = await buildMarketPulseSnapshotFromStore(store, {
    sourceName: SOURCE,
    priceField: 'trendPrice',
    currencyCode: 'EUR',
    tcgCode: 'pulse-smoke-game',
    setCode: 'pulse-set',
    generatedAt: CURRENT + 60_000,
  });

  assert.equal(pulse.evidenceSourceType, 'postgres');
  assert.equal(pulse.anchorMarketDay, '2026-09-03');
  assert.equal(pulse.cards.length, 1);
  assert.equal(pulse.cards[0].name, 'Pulse Test Card');
  assert.equal(pulse.cards[0].tcgCode, 'pulse-smoke-game');
  assert.equal(pulse.cards[0].setCode, 'pulse-set');
  assert.deepEqual(pulse.cards[0].movement.d7, { amount: 25, percent: 25 });
  assert.equal(pulse.movement.d7.coveragePct, 100);

  const readiness = await buildMarketDataReadinessReport(store, { sourceName: SOURCE });
  assert.equal(readiness.canonicalSchemaAvailable, true);
  assert.equal(readiness.marketHistorySchemaAvailable, true);
  assert.equal(readiness.history.observations, 2);
  assert.equal(readiness.history.observedCards, 1);
  assert.equal(readiness.history.latestMarketDay, '2026-09-03');
  assert.equal(readiness.history.currentLaneCount, 1);
  assert.deepEqual(readiness.history.exactBaselineCoverage.d7, {
    baselineMarketDay: '2026-08-27',
    eligibleLanes: 1,
    coveredLanes: 1,
    coveragePct: 100,
  });

  console.log('Market Pulse PostgreSQL read bridge and readiness smoke rehearsal passed');
} finally {
  await pool.end();
}
