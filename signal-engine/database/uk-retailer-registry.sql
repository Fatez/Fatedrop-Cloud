-- Additive migration for UK Retailer Intelligence Network v1.
-- Do not apply automatically in production. Review and run deliberately.

CREATE TABLE IF NOT EXISTS fatedrop_retailer_registry (
  retailer_id TEXT PRIMARY KEY,
  retailer_name TEXT NOT NULL,
  website_url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'GB',
  retailer_class TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'candidate',
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  rrp_authority TEXT NOT NULL DEFAULT 'none',
  tcgs JSONB NOT NULL DEFAULT '[]'::jsonb,
  online BOOLEAN NOT NULL DEFAULT TRUE,
  physical_locations INTEGER NOT NULL DEFAULT 0,
  catalogue_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  monitoring_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovery JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(hostname)
);

CREATE INDEX IF NOT EXISTS fatedrop_retailer_registry_state_idx
  ON fatedrop_retailer_registry(lifecycle_state, retailer_class);
CREATE INDEX IF NOT EXISTS fatedrop_retailer_registry_adapter_idx
  ON fatedrop_retailer_registry(adapter_type, lifecycle_state);
CREATE INDEX IF NOT EXISTS fatedrop_retailer_registry_verification_idx
  ON fatedrop_retailer_registry(verification_state);

CREATE TABLE IF NOT EXISTS fatedrop_retailer_discovery_evidence (
  evidence_id TEXT PRIMARY KEY,
  retailer_id TEXT REFERENCES fatedrop_retailer_registry(retailer_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_url TEXT,
  observed_at BIGINT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(retailer_id, source_type, source_url)
);

CREATE INDEX IF NOT EXISTS fatedrop_retailer_discovery_evidence_retailer_idx
  ON fatedrop_retailer_discovery_evidence(retailer_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_retailer_monitor_runs (
  run_id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL REFERENCES fatedrop_retailer_registry(retailer_id) ON DELETE CASCADE,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  status TEXT NOT NULL,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  products_observed INTEGER NOT NULL DEFAULT 0,
  catalogue_complete BOOLEAN NOT NULL DEFAULT FALSE,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  failure_code TEXT,
  failure_detail TEXT,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS fatedrop_retailer_monitor_runs_retailer_time_idx
  ON fatedrop_retailer_monitor_runs(retailer_id, started_at DESC);
