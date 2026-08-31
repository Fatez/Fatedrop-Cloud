-- Additive Local Radar v2 branch identity/evidence migration.
-- This migration does not import, delete, geocode, or change stock lifecycle data.

ALTER TABLE fatedrop_retailer_locations
  ADD COLUMN IF NOT EXISTS retailer_category TEXT NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS store_format TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS operational_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS tcg_seller_status TEXT NOT NULL DEFAULT 'candidate',
  ADD COLUMN IF NOT EXISTS tcg_seller_confidence SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'canonical',
  ADD COLUMN IF NOT EXISTS last_verified_at BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fatedrop_retailer_locations_category_check') THEN
    ALTER TABLE fatedrop_retailer_locations ADD CONSTRAINT fatedrop_retailer_locations_category_check
      CHECK (retailer_category IN ('book_stationery','entertainment','general_retail','hobby_store','specialist_tcg','supermarket','toy_store','value_retail','warehouse_club','other')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fatedrop_retailer_locations_operational_check') THEN
    ALTER TABLE fatedrop_retailer_locations ADD CONSTRAINT fatedrop_retailer_locations_operational_check
      CHECK (operational_status IN ('open','opening_soon','closed','unknown')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fatedrop_retailer_locations_seller_check') THEN
    ALTER TABLE fatedrop_retailer_locations ADD CONSTRAINT fatedrop_retailer_locations_seller_check
      CHECK (tcg_seller_status IN ('verified','likely','candidate','excluded','conflicted')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fatedrop_retailer_locations_confidence_check') THEN
    ALTER TABLE fatedrop_retailer_locations ADD CONSTRAINT fatedrop_retailer_locations_confidence_check
      CHECK (tcg_seller_confidence BETWEEN 0 AND 100) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fatedrop_retailer_locations_identity_check') THEN
    ALTER TABLE fatedrop_retailer_locations ADD CONSTRAINT fatedrop_retailer_locations_identity_check
      CHECK (identity_status IN ('canonical','provisional','conflicted')) NOT VALID;
  END IF;
END $$;

ALTER TABLE fatedrop_retailer_locations VALIDATE CONSTRAINT fatedrop_retailer_locations_category_check;
ALTER TABLE fatedrop_retailer_locations VALIDATE CONSTRAINT fatedrop_retailer_locations_operational_check;
ALTER TABLE fatedrop_retailer_locations VALIDATE CONSTRAINT fatedrop_retailer_locations_seller_check;
ALTER TABLE fatedrop_retailer_locations VALIDATE CONSTRAINT fatedrop_retailer_locations_confidence_check;
ALTER TABLE fatedrop_retailer_locations VALIDATE CONSTRAINT fatedrop_retailer_locations_identity_check;

CREATE INDEX IF NOT EXISTS fatedrop_retailer_locations_bounds_idx
  ON fatedrop_retailer_locations (latitude, longitude);
CREATE INDEX IF NOT EXISTS fatedrop_retailer_locations_postcode_idx
  ON fatedrop_retailer_locations (UPPER(REPLACE(postcode, ' ', '')))
  WHERE postcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS fatedrop_retailer_locations_radar_eligibility_idx
  ON fatedrop_retailer_locations (operational_status, identity_status, tcg_seller_status, retailer_category);

CREATE TABLE IF NOT EXISTS fatedrop_retailer_location_sources (
  evidence_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES fatedrop_retailer_locations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_id TEXT,
  source_url TEXT,
  observed_at BIGINT NOT NULL,
  checked_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted','rejected','superseded')),
  confidence SMALLINT NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (location_id, provider, provider_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_retailer_location_sources_location_idx
  ON fatedrop_retailer_location_sources (location_id, status, checked_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_retailer_location_conflicts (
  conflict_id TEXT PRIMARY KEY,
  location_id TEXT REFERENCES fatedrop_retailer_locations(id) ON DELETE CASCADE,
  conflicting_location_id TEXT REFERENCES fatedrop_retailer_locations(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  conflicting_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolution JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (location_id IS NOT NULL OR conflicting_location_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fatedrop_retailer_location_conflicts_open_idx
  ON fatedrop_retailer_location_conflicts (status, created_at DESC)
  WHERE status='open';
