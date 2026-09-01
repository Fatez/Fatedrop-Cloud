CREATE TABLE IF NOT EXISTS fatedrop_retailer_intelligence_surfaces (
  surface_id TEXT PRIMARY KEY,
  retailer_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  last_changed_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fatedrop_retailer_intelligence_surfaces_retailer
  ON fatedrop_retailer_intelligence_surfaces (retailer_id, last_changed_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_retailer_intelligence_snapshot_history (
  surface_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  retailer_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_observed_at BIGINT NOT NULL,
  last_observed_at BIGINT NOT NULL,
  snapshot_json JSONB NOT NULL,
  PRIMARY KEY (surface_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_fatedrop_retailer_intelligence_history_retailer
  ON fatedrop_retailer_intelligence_snapshot_history (retailer_id, last_observed_at DESC);
