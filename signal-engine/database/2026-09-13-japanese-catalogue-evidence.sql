-- FateDrop Japanese catalogue/evidence lane.
-- Additive and backwards-compatible with the English PR #489 recovery tables.

BEGIN;

ALTER TABLE fatedrop_variant_evidence_snapshots
  DROP CONSTRAINT IF EXISTS fatedrop_variant_evidence_snapshots_provider_check;
ALTER TABLE fatedrop_variant_evidence_snapshots
  ADD CONSTRAINT fatedrop_variant_evidence_snapshots_provider_check
  CHECK (provider IN ('scrydex','tcgplayer','cardmarket','set_rule','manual','tcgdex','yuyutei'));

ALTER TABLE fatedrop_variant_evidence_reviews
  ADD COLUMN IF NOT EXISTS marker_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE fatedrop_variant_evidence_reviews
  DROP CONSTRAINT IF EXISTS fatedrop_variant_evidence_reviews_marker_type_check;
ALTER TABLE fatedrop_variant_evidence_reviews
  ADD CONSTRAINT fatedrop_variant_evidence_reviews_marker_type_check
  CHECK (marker_type IN ('none','pokeball_reverse','masterball_reverse'));

ALTER TABLE fatedrop_variant_resolution_state
  ADD COLUMN IF NOT EXISTS marker_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE fatedrop_variant_resolution_state
  DROP CONSTRAINT IF EXISTS fatedrop_variant_resolution_state_marker_type_check;
ALTER TABLE fatedrop_variant_resolution_state
  ADD CONSTRAINT fatedrop_variant_resolution_state_marker_type_check
  CHECK (marker_type IN ('none','pokeball_reverse','masterball_reverse'));

ALTER TABLE fatedrop_variant_audit_hold
  ADD COLUMN IF NOT EXISTS marker_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE fatedrop_variant_audit_hold
  DROP CONSTRAINT IF EXISTS fatedrop_variant_audit_hold_marker_type_check;
ALTER TABLE fatedrop_variant_audit_hold
  ADD CONSTRAINT fatedrop_variant_audit_hold_marker_type_check
  CHECK (marker_type IN ('none','pokeball_reverse','masterball_reverse'));

CREATE TABLE IF NOT EXISTS fatedrop_catalogue_evidence_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('tcgdex','scrydex','cardmarket','tcgplayer','yuyutei','set_rule','manual')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('set_manifest','set','card','image_probe')),
  source_locator TEXT NOT NULL,
  source_record_id TEXT,
  set_code TEXT,
  observed_at BIGINT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload_text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (provider, source_locator, payload_sha256)
);

CREATE OR REPLACE FUNCTION fatedrop_reject_catalogue_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fatedrop_catalogue_evidence_snapshots is immutable';
END
$$;

DROP TRIGGER IF EXISTS fatedrop_catalogue_evidence_snapshots_immutable
  ON fatedrop_catalogue_evidence_snapshots;
CREATE TRIGGER fatedrop_catalogue_evidence_snapshots_immutable
BEFORE UPDATE OR DELETE ON fatedrop_catalogue_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION fatedrop_reject_catalogue_evidence_mutation();

CREATE TABLE IF NOT EXISTS fatedrop_evidence_audit_flags (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  flag_type TEXT NOT NULL CHECK (flag_type IN (
    'missing_thumbnail',
    'broken_thumbnail',
    'provider_network_failure',
    'payload_schema_error',
    'cross_source_conflict',
    'unrecognised_variant_label'
  )),
  provider TEXT,
  set_code TEXT,
  source_record_id TEXT,
  card_identity_id TEXT REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  source_locator TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_catalogue_evidence_run_idx
  ON fatedrop_catalogue_evidence_snapshots (run_id, provider, scope_type);
CREATE INDEX IF NOT EXISTS fatedrop_evidence_audit_flags_run_idx
  ON fatedrop_evidence_audit_flags (run_id, flag_type, active);

COMMIT;
