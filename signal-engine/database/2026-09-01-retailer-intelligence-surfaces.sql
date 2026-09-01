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
