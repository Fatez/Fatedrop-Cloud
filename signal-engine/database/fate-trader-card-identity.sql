-- Fate Trader v1: canonical collectible-card identity graph.
--
-- This schema is intentionally separate from sealed-product identities. A card
-- printing is a different identity domain from an ETB/booster-box product.
-- Condition, grading, certification and photographs belong to a user's
-- physical collection item and MUST NOT be encoded into fate_card_id.

CREATE TABLE IF NOT EXISTS fatedrop_tcgs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS fatedrop_card_series (
  id TEXT PRIMARY KEY,
  tcg_id TEXT NOT NULL REFERENCES fatedrop_tcgs(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  release_order INTEGER,
  released_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(tcg_id, code)
);

CREATE TABLE IF NOT EXISTS fatedrop_card_sets (
  id TEXT PRIMARY KEY,
  tcg_id TEXT NOT NULL REFERENCES fatedrop_tcgs(id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL REFERENCES fatedrop_card_series(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  printed_total INTEGER,
  total INTEGER,
  released_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(tcg_id, code)
);

-- A printing is the catalogue-level card record before language/finish variant
-- is applied. `printing_code` is an adapter-supplied stable discriminator where
-- a set/card-number combination can have more than one distinct printing.
CREATE TABLE IF NOT EXISTS fatedrop_card_printings (
  id TEXT PRIMARY KEY,
  tcg_id TEXT NOT NULL REFERENCES fatedrop_tcgs(id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL REFERENCES fatedrop_card_series(id) ON DELETE RESTRICT,
  set_id TEXT NOT NULL REFERENCES fatedrop_card_sets(id) ON DELETE RESTRICT,
  printing_code TEXT NOT NULL,
  collector_number TEXT NOT NULL,
  name TEXT NOT NULL,
  rarity TEXT,
  supertype TEXT,
  subtypes JSONB NOT NULL DEFAULT '[]'::jsonb,
  national_dex_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(set_id, printing_code, collector_number)
);

-- One exact printed identity used everywhere in FateDrop: Collection,
-- Wishlist, Fate Trader, Trade Finder and future market intelligence.
CREATE TABLE IF NOT EXISTS fatedrop_card_identities (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  tcg_id TEXT NOT NULL REFERENCES fatedrop_tcgs(id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL REFERENCES fatedrop_card_series(id) ON DELETE RESTRICT,
  set_id TEXT NOT NULL REFERENCES fatedrop_card_sets(id) ON DELETE RESTRICT,
  printing_id TEXT NOT NULL REFERENCES fatedrop_card_printings(id) ON DELETE RESTRICT,
  collector_number TEXT NOT NULL,
  variant_code TEXT NOT NULL,
  language_code TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (verification_status IN ('staged', 'verified', 'conflict', 'quarantined', 'retired')),
  verified_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (verification_status <> 'verified' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fatedrop_card_identities_set_idx
  ON fatedrop_card_identities(set_id, collector_number);

CREATE INDEX IF NOT EXISTS fatedrop_card_identities_printing_idx
  ON fatedrop_card_identities(printing_id);

CREATE INDEX IF NOT EXISTS fatedrop_card_identities_verified_idx
  ON fatedrop_card_identities(verification_status, tcg_id, set_id)
  WHERE verification_status = 'verified';

-- External IDs never become FateDrop's identity. A single upstream card record
-- may describe several finish variants, so source_variant_key is part of the
-- mapping identity even though it is not an upstream primary key.
CREATE TABLE IF NOT EXISTS fatedrop_card_source_mappings (
  id TEXT PRIMARY KEY,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_variant_key TEXT NOT NULL,
  source_url TEXT,
  source_version TEXT,
  first_observed_at BIGINT NOT NULL,
  last_observed_at BIGINT NOT NULL,
  UNIQUE(source_name, source_record_id, source_variant_key)
);

CREATE INDEX IF NOT EXISTS fatedrop_card_source_mappings_identity_idx
  ON fatedrop_card_source_mappings(card_identity_id);

-- Field-level/source-level evidence retained for reconciliation and audit.
CREATE TABLE IF NOT EXISTS fatedrop_card_provenance (
  id TEXT PRIMARY KEY,
  card_identity_id TEXT REFERENCES fatedrop_card_identities(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_variant_key TEXT NOT NULL,
  source_url TEXT,
  observed_at BIGINT NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (evidence_status IN ('staged', 'accepted', 'conflict', 'rejected')),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_card_provenance_identity_time_idx
  ON fatedrop_card_provenance(card_identity_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_card_provenance_source_idx
  ON fatedrop_card_provenance(source_name, source_record_id, source_variant_key);

-- Conflicting upstream identities are quarantined rather than guessed through.
CREATE TABLE IF NOT EXISTS fatedrop_card_identity_conflicts (
  id TEXT PRIMARY KEY,
  canonical_key TEXT,
  source_name TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_variant_key TEXT,
  conflict_type TEXT NOT NULL,
  existing_evidence JSONB,
  incoming_evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  resolution TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE INDEX IF NOT EXISTS fatedrop_card_identity_conflicts_open_idx
  ON fatedrop_card_identity_conflicts(created_at DESC)
  WHERE status = 'open';
