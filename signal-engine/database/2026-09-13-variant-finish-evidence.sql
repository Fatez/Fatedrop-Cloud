BEGIN;

CREATE TABLE IF NOT EXISTS fatedrop_variant_evidence_snapshots (
  id TEXT PRIMARY KEY,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('scrydex','tcgplayer','cardmarket','set_rule','manual')),
  source_locator TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  observed_at BIGINT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(provider, card_identity_id, payload_sha256)
);

CREATE INDEX IF NOT EXISTS fatedrop_variant_evidence_snapshots_identity_time_idx
  ON fatedrop_variant_evidence_snapshots(card_identity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_variant_evidence_snapshots_provider_idx
  ON fatedrop_variant_evidence_snapshots(provider, observed_at DESC);

CREATE OR REPLACE FUNCTION fatedrop_reject_variant_evidence_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'variant evidence snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_variant_evidence_snapshots_immutable ON fatedrop_variant_evidence_snapshots;
CREATE TRIGGER fatedrop_variant_evidence_snapshots_immutable
BEFORE UPDATE OR DELETE ON fatedrop_variant_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION fatedrop_reject_variant_evidence_snapshot_mutation();

CREATE TABLE IF NOT EXISTS fatedrop_variant_evidence_reviews (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES fatedrop_variant_evidence_snapshots(id) ON DELETE RESTRICT,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  finish TEXT NOT NULL CHECK (finish IN ('standard','holo','reverse_holo')),
  language TEXT NOT NULL,
  edition TEXT NOT NULL,
  observed_finish TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('exists','does_not_exist')),
  basis TEXT NOT NULL CHECK (basis IN ('explicit_variant_record','exact_printing_checklist')),
  review_reference TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending','approved','rejected')),
  reviewed_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE(snapshot_id, card_identity_id, finish, verdict, review_reference)
);

CREATE INDEX IF NOT EXISTS fatedrop_variant_evidence_reviews_identity_idx
  ON fatedrop_variant_evidence_reviews(card_identity_id, finish, approval_state);

CREATE TABLE IF NOT EXISTS fatedrop_variant_resolution_state (
  card_identity_id TEXT PRIMARY KEY REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  finish TEXT NOT NULL CHECK (finish IN ('standard','holo','reverse_holo')),
  language TEXT NOT NULL,
  edition TEXT NOT NULL,
  classifier_state TEXT NOT NULL CHECK (classifier_state IN ('ACTIVE_PRICED','ACTIVE_UNPRICED','INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')),
  reason TEXT NOT NULL,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  review_reference TEXT,
  classified_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_variant_resolution_state_state_idx
  ON fatedrop_variant_resolution_state(classifier_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_catalogue_audit_flags (
  id TEXT PRIMARY KEY,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  flag_type TEXT NOT NULL CHECK (flag_type IN ('invalid_catalogue_entry')),
  reason TEXT NOT NULL,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  review_reference TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_catalogue_audit_flags_active_unique
  ON fatedrop_catalogue_audit_flags(card_identity_id, flag_type)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS fatedrop_variant_audit_hold (
  card_identity_id TEXT PRIMARY KEY REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  finish TEXT NOT NULL CHECK (finish IN ('standard','holo','reverse_holo')),
  reason TEXT NOT NULL,
  evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

COMMIT;
