-- Fate Value Lab phase 1: source-agnostic market history.
--
-- This schema deliberately does NOT calculate a Fate Fair Value. It only
-- preserves mapped market evidence so valuation policy can be developed and
-- backtested later without rewriting history.
--
-- Canonical card identity remains owned by fatedrop_card_identities.
-- External market identifiers remain crosswalks in fatedrop_card_source_mappings.
-- Condition is market/physical evidence and MUST NOT be encoded into fate_card_id.

CREATE TABLE IF NOT EXISTS fatedrop_market_ingest_runs (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  source_version TEXT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  records_seen INTEGER NOT NULL DEFAULT 0 CHECK (records_seen >= 0),
  records_accepted INTEGER NOT NULL DEFAULT 0 CHECK (records_accepted >= 0),
  records_rejected INTEGER NOT NULL DEFAULT 0 CHECK (records_rejected >= 0),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  CHECK (records_accepted + records_rejected <= records_seen),
  CHECK (status = 'running' OR completed_at IS NOT NULL),
  UNIQUE(source_name, source_snapshot_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_market_ingest_runs_source_time_idx
  ON fatedrop_market_ingest_runs(source_name, started_at DESC);

-- One row is one mapped market observation for one exact source snapshot.
-- New snapshots append new rows. Re-running the exact same source snapshot is
-- idempotent through the unique source/snapshot/card/segment constraint below.
-- content_fingerprint lets persistence reject an attempted mutation of an
-- already-recorded logical observation instead of silently overwriting history.
CREATE TABLE IF NOT EXISTS fatedrop_market_observations (
  id TEXT PRIMARY KEY,
  ingest_run_id TEXT NOT NULL REFERENCES fatedrop_market_ingest_runs(id) ON DELETE RESTRICT,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  card_source_mapping_id TEXT NOT NULL REFERENCES fatedrop_card_source_mappings(id) ON DELETE RESTRICT,
  source_name TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_variant_key TEXT NOT NULL,
  market_segment_key TEXT NOT NULL DEFAULT 'default',
  condition_code TEXT NOT NULL DEFAULT 'unspecified',
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  observed_at BIGINT NOT NULL,
  source_effective_at BIGINT,
  market_day DATE NOT NULL,
  market_price NUMERIC(20,6),
  low_price NUMERIC(20,6),
  trend_price NUMERIC(20,6),
  avg_1d NUMERIC(20,6),
  avg_7d NUMERIC(20,6),
  avg_30d NUMERIC(20,6),
  avg_lifetime NUMERIC(20,6),
  excellent_plus_low NUMERIC(20,6),
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_fingerprint TEXT NOT NULL CHECK (content_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at BIGINT NOT NULL,
  CHECK (market_price IS NULL OR market_price >= 0),
  CHECK (low_price IS NULL OR low_price >= 0),
  CHECK (trend_price IS NULL OR trend_price >= 0),
  CHECK (avg_1d IS NULL OR avg_1d >= 0),
  CHECK (avg_7d IS NULL OR avg_7d >= 0),
  CHECK (avg_30d IS NULL OR avg_30d >= 0),
  CHECK (avg_lifetime IS NULL OR avg_lifetime >= 0),
  CHECK (excellent_plus_low IS NULL OR excellent_plus_low >= 0),
  CHECK (
    market_price IS NOT NULL OR low_price IS NOT NULL OR trend_price IS NOT NULL
    OR avg_1d IS NOT NULL OR avg_7d IS NOT NULL OR avg_30d IS NOT NULL
    OR avg_lifetime IS NOT NULL OR excellent_plus_low IS NOT NULL
    OR metrics_json <> '{}'::jsonb
  ),
  UNIQUE(
    source_name,
    source_snapshot_id,
    source_record_id,
    source_variant_key,
    market_segment_key,
    condition_code,
    currency_code
  )
);

CREATE INDEX IF NOT EXISTS fatedrop_market_observations_card_time_idx
  ON fatedrop_market_observations(card_identity_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_market_observations_source_time_idx
  ON fatedrop_market_observations(source_name, observed_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_market_observations_market_day_idx
  ON fatedrop_market_observations(market_day DESC, card_identity_id);

-- Evidence that cannot be safely mapped is retained separately instead of
-- guessing a card identity. This is the market-data equivalent of "unknown
-- stays unknown" and gives catalogue reconciliation an audit queue.
CREATE TABLE IF NOT EXISTS fatedrop_market_ingest_rejections (
  id TEXT PRIMARY KEY,
  ingest_run_id TEXT NOT NULL REFERENCES fatedrop_market_ingest_runs(id) ON DELETE RESTRICT,
  source_name TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  source_record_id TEXT,
  source_variant_key TEXT,
  rejection_code TEXT NOT NULL,
  rejection_detail TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_market_ingest_rejections_run_idx
  ON fatedrop_market_ingest_rejections(ingest_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_market_ingest_rejections_source_idx
  ON fatedrop_market_ingest_rejections(source_name, rejection_code, created_at DESC);
