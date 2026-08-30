CREATE TABLE IF NOT EXISTS fatedrop_product_market_memory (
  product_identity_id TEXT PRIMARY KEY REFERENCES fatedrop_product_identities(id) ON DELETE CASCADE,
  market_code TEXT NOT NULL CHECK (market_code IN ('GB','US','CA','AU','NZ','IE','JP','KR','CN','TW','HK')),
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','conflict')),
  verification_method TEXT NOT NULL,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  verified_at BIGINT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  conflicting_market_code TEXT CHECK (conflicting_market_code IS NULL OR conflicting_market_code IN ('GB','US','CA','AU','NZ','IE','JP','KR','CN','TW','HK')),
  conflict_detected_at BIGINT,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS fatedrop_product_market_memory_status_idx
  ON fatedrop_product_market_memory(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_product_market_observations (
  id TEXT PRIMARY KEY,
  product_identity_id TEXT NOT NULL REFERENCES fatedrop_product_identities(id) ON DELETE CASCADE,
  offer_id TEXT,
  retailer_id TEXT,
  observed_title TEXT NOT NULL,
  observed_market_code TEXT CHECK (observed_market_code IS NULL OR observed_market_code IN ('GB','US','CA','AU','NZ','IE','JP','KR','CN','TW','HK')),
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('unknown','candidate','verified','reused','conflict')),
  resolution_source TEXT NOT NULL,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  identity_resolution_kind TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS fatedrop_product_market_observations_identity_time_idx
  ON fatedrop_product_market_observations(product_identity_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_product_market_observations_conflict_idx
  ON fatedrop_product_market_observations(resolution_status, last_seen_at DESC)
  WHERE resolution_status='conflict';
