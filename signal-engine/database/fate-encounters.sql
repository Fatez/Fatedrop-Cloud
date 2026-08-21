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

CREATE TABLE IF NOT EXISTS fatedrop_encounter_vendors (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES fatedrop_encounters(id) ON DELETE CASCADE,
  retailer_id TEXT,
  name TEXT NOT NULL,
  website_url TEXT,
  stall_label TEXT,
  zone_label TEXT,
  supported_tcgs TEXT[] NOT NULL DEFAULT '{}',
  verification_status TEXT NOT NULL DEFAULT 'submitted' CHECK (verification_status IN ('submitted','source_verified','fatedrop_verified')),
  source_type TEXT NOT NULL DEFAULT 'organiser_submission' CHECK (source_type IN ('organiser_submission','retailer_submission','manual_research','authorised_feed','official_tcg')),
  source_url TEXT,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS fatedrop_encounter_vendor_inventory (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES fatedrop_encounters(id) ON DELETE CASCADE,
  vendor_id TEXT NOT NULL REFERENCES fatedrop_encounter_vendors(id) ON DELETE CASCADE,
  product_id TEXT,
  title TEXT NOT NULL,
  price_pence INTEGER,
  quantity INTEGER,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available','low_stock','sold_out','unknown')),
  evidence_scope TEXT NOT NULL DEFAULT 'event_vendor_submission' CHECK (evidence_scope IN ('event_vendor_submission','fatedrop_event_inventory')),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fatedrop_encounters_start_idx ON fatedrop_encounters (start_at);
CREATE INDEX IF NOT EXISTS fatedrop_encounters_postcode_idx ON fatedrop_encounters (postcode);
CREATE INDEX IF NOT EXISTS fatedrop_encounters_tcgs_idx ON fatedrop_encounters USING GIN (supported_tcgs);
CREATE INDEX IF NOT EXISTS fatedrop_encounter_vendors_event_idx ON fatedrop_encounter_vendors (event_id);
CREATE INDEX IF NOT EXISTS fatedrop_encounter_vendor_inventory_event_idx ON fatedrop_encounter_vendor_inventory (event_id);
CREATE INDEX IF NOT EXISTS fatedrop_encounter_vendor_inventory_vendor_idx ON fatedrop_encounter_vendor_inventory (vendor_id);
