CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_auth_id TEXT UNIQUE,
  premium BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retailers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retailer_type TEXT NOT NULL CHECK (retailer_type IN ('MAJOR', 'INDIE')),
  location TEXT,
  website TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  default_delivery_cost NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_title TEXT NOT NULL,
  rrp NUMERIC(10,2),
  currency CHAR(3) NOT NULL DEFAULT 'GBP',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retailer_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  external_id TEXT,
  sku TEXT,
  title TEXT NOT NULL,
  url TEXT,
  UNIQUE (retailer_id, external_id),
  UNIQUE (retailer_id, sku)
);

CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_product_id UUID NOT NULL REFERENCES retailer_products(id) ON DELETE CASCADE,
  item_price NUMERIC(10,2) NOT NULL,
  delivery_cost NUMERIC(10,2),
  mandatory_fees NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_quantity INTEGER,
  availability TEXT,
  preorder BOOLEAN NOT NULL DEFAULT FALSE,
  total_delivered_cost NUMERIC(10,2),
  item_premium_percent NUMERIC(10,2),
  delivered_premium_percent NUMERIC(10,2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retailer_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  queue_active BOOLEAN,
  catalogue_fingerprint TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retailer_snapshots_retailer_observed_idx
  ON retailer_snapshots (retailer_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_events (
  id UUID PRIMARY KEY,
  family TEXT NOT NULL,
  type TEXT NOT NULL,
  retailer_id TEXT REFERENCES retailers(id) ON DELETE SET NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  severity TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_events_created_idx
  ON fatedrop_events (created_at DESC);

CREATE TABLE IF NOT EXISTS signal_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id TEXT NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  highest_state TEXT NOT NULL,
  highest_score INTEGER NOT NULL DEFAULT 0,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  manifested BOOLEAN NOT NULL DEFAULT FALSE,
  manifested_at TIMESTAMPTZ,
  minutes_to_manifestation INTEGER,
  false_alarm BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_episodes_retailer_started_idx
  ON signal_episodes (retailer_id, started_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES fatedrop_events(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  recipient TEXT,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  retailer_id TEXT REFERENCES retailers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collector_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  venue TEXT,
  location TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
