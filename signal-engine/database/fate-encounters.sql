CREATE TABLE IF NOT EXISTS fatedrop_encounters (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  venue_name TEXT,
  address TEXT,
  town_city TEXT,
  postcode TEXT,
  region TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  ticket_price_text TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  supported_tcgs TEXT[] NOT NULL DEFAULT '{}',
  image_url TEXT,
  organiser_name TEXT,
  official_event_url TEXT,
  official_ticket_url TEXT,
  vendor_information_url TEXT,
  vendor_applications_status TEXT NOT NULL DEFAULT 'unknown' CHECK (vendor_applications_status IN ('open','closed','unknown')),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'submitted' CHECK (verification_status IN ('submitted','source_verified','fatedrop_verified')),
  source_type TEXT NOT NULL DEFAULT 'manual_research' CHECK (source_type IN ('organiser_submission','retailer_submission','manual_research','authorised_feed','official_tcg')),
  source_url TEXT,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fatedrop_encounters_start_idx ON fatedrop_encounters (start_at);
CREATE INDEX IF NOT EXISTS fatedrop_encounters_postcode_idx ON fatedrop_encounters (postcode);
CREATE INDEX IF NOT EXISTS fatedrop_encounters_tcgs_idx ON fatedrop_encounters USING GIN (supported_tcgs);
