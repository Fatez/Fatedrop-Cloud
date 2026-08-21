ALTER TABLE fatedrop_product_identities
  ADD COLUMN IF NOT EXISTS language_code TEXT,
  ADD COLUMN IF NOT EXISTS region_code TEXT,
  ADD COLUMN IF NOT EXISTS exclusive_kind TEXT,
  ADD COLUMN IF NOT EXISTS unit_kind TEXT,
  ADD COLUMN IF NOT EXISTS format_variant TEXT,
  ADD COLUMN IF NOT EXISTS presentation TEXT,
  ADD COLUMN IF NOT EXISTS pack_count INTEGER,
  ADD COLUMN IF NOT EXISTS case_quantity INTEGER;

ALTER TABLE fatedrop_retail_offers
  ADD COLUMN IF NOT EXISTS gtin TEXT;

ALTER TABLE fatedrop_offers
  ADD COLUMN IF NOT EXISTS gtin TEXT;

CREATE TABLE IF NOT EXISTS fatedrop_product_identifiers (
  id TEXT PRIMARY KEY,
  product_identity_id TEXT NOT NULL REFERENCES fatedrop_product_identities(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('manufacturer', 'official_store', 'authorized_distributor', 'retailer')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at BIGINT NOT NULL,
  verified_at BIGINT,
  UNIQUE(namespace, identifier_value)
);

CREATE INDEX IF NOT EXISTS fatedrop_product_identifiers_identity_idx
  ON fatedrop_product_identifiers(product_identity_id);

CREATE TABLE IF NOT EXISTS fatedrop_rrp_evidence (
  id TEXT PRIMARY KEY,
  product_identity_id TEXT NOT NULL REFERENCES fatedrop_product_identities(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_pence BIGINT NOT NULL CHECK (price_pence > 0),
  price_kind TEXT NOT NULL CHECK (price_kind IN ('rrp', 'msrp', 'official_store_price')),
  source_role TEXT NOT NULL CHECK (source_role IN ('manufacturer', 'official_store', 'authorized_distributor')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_identifier_namespace TEXT,
  source_identifier_value TEXT,
  observed_at BIGINT NOT NULL,
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('eligible', 'reference_only', 'conflict')),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  UNIQUE(product_identity_id, source_url, price_kind, price_pence, observed_at)
);

CREATE INDEX IF NOT EXISTS fatedrop_rrp_evidence_identity_time_idx
  ON fatedrop_rrp_evidence(product_identity_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_rrp_evidence_source_identifier_idx
  ON fatedrop_rrp_evidence(source_identifier_namespace, source_identifier_value)
  WHERE source_identifier_namespace IS NOT NULL AND source_identifier_value IS NOT NULL;
