-- Fate Trader v1 catalogue reconciliation persistence.
-- Applied after fate-trader-card-identity.sql.

ALTER TABLE fatedrop_card_series
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (verification_status IN ('staged', 'verified', 'conflict', 'quarantined', 'retired')),
  ADD COLUMN IF NOT EXISTS verified_at BIGINT;

ALTER TABLE fatedrop_card_sets
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (verification_status IN ('staged', 'verified', 'conflict', 'quarantined', 'retired')),
  ADD COLUMN IF NOT EXISTS verified_at BIGINT;

ALTER TABLE fatedrop_card_printings
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (verification_status IN ('staged', 'verified', 'conflict', 'quarantined', 'retired')),
  ADD COLUMN IF NOT EXISTS verified_at BIGINT;

-- A canonical FateDrop set owns the identity. Provider IDs are only crosswalks.
CREATE TABLE IF NOT EXISTS fatedrop_card_set_source_mappings (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES fatedrop_card_sets(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_series_code TEXT,
  source_url TEXT,
  source_version TEXT,
  first_observed_at BIGINT NOT NULL,
  last_observed_at BIGINT NOT NULL,
  UNIQUE(source_name, source_record_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_card_set_source_mappings_set_idx
  ON fatedrop_card_set_source_mappings(set_id);

-- Raw provider set evidence is retained even before a canonical set is accepted.
CREATE TABLE IF NOT EXISTS fatedrop_card_set_provenance (
  id TEXT PRIMARY KEY,
  set_id TEXT REFERENCES fatedrop_card_sets(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_url TEXT,
  observed_at BIGINT NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (evidence_status IN ('staged', 'accepted', 'conflict', 'rejected')),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_card_set_provenance_source_idx
  ON fatedrop_card_set_provenance(source_name, source_record_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_card_set_provenance_set_idx
  ON fatedrop_card_set_provenance(set_id, observed_at DESC)
  WHERE set_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fatedrop_card_set_conflicts (
  id TEXT PRIMARY KEY,
  source_a_name TEXT NOT NULL,
  source_a_record_id TEXT NOT NULL,
  source_b_name TEXT NOT NULL,
  source_b_record_id TEXT NOT NULL,
  conflict_field TEXT NOT NULL,
  source_a_evidence JSONB NOT NULL,
  source_b_evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  resolution TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE INDEX IF NOT EXISTS fatedrop_card_set_conflicts_open_idx
  ON fatedrop_card_set_conflicts(created_at DESC)
  WHERE status = 'open';
