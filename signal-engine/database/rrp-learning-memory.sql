CREATE TABLE IF NOT EXISTS fatedrop_rrp_resolution_queue (
  id text PRIMARY KEY,
  tcg text NOT NULL DEFAULT 'pokemon',
  product_id text,
  offer_id text,
  retailer_id text NOT NULL,
  observed_title text NOT NULL,
  product_type text,
  language_code text,
  region_code text,
  failure_reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','candidate','resolved','genuine_unknown','conflict')),
  candidate_identity_id text REFERENCES fatedrop_product_identities(id) ON DELETE SET NULL,
  candidate_confidence numeric,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  resolved_at bigint,
  resolution_source text,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_rrp_resolution_queue_identity_uq
  ON fatedrop_rrp_resolution_queue (retailer_id, observed_title, COALESCE(product_type,''));

CREATE INDEX IF NOT EXISTS fatedrop_rrp_resolution_queue_status_last_seen_idx
  ON fatedrop_rrp_resolution_queue (status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_product_identity_aliases (
  id text PRIMARY KEY,
  tcg text NOT NULL DEFAULT 'pokemon',
  alias_signature text NOT NULL,
  observed_title text NOT NULL,
  product_type text,
  canonical_product_identity_id text NOT NULL REFERENCES fatedrop_product_identities(id) ON DELETE CASCADE,
  resolution_kind text NOT NULL CHECK (resolution_kind IN ('verified_alias','verified_abbreviation','verified_wording','verified_identifier')),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source text NOT NULL,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  verified_at bigint NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_product_identity_aliases_signature_uq
  ON fatedrop_product_identity_aliases (tcg, alias_signature, COALESCE(product_type,''));

CREATE INDEX IF NOT EXISTS fatedrop_product_identity_aliases_canonical_idx
  ON fatedrop_product_identity_aliases (canonical_product_identity_id);
