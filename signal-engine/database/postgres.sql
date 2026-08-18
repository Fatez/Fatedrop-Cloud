CREATE TABLE IF NOT EXISTS fatedrop_products (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  product_type TEXT NOT NULL,
  tcg TEXT NOT NULL DEFAULT 'pokemon',
  official_rrp_pence INTEGER,
  rrp_source TEXT,
  rrp_observed_at BIGINT,
  first_seen_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS fatedrop_retail_offers (
  offer_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES fatedrop_products(id),
  retailer_id TEXT NOT NULL,
  retailer_name TEXT NOT NULL,
  retailer_sku TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  price_pence INTEGER,
  postage_pence INTEGER,
  stock_status TEXT NOT NULL,
  stock_confidence DOUBLE PRECISION NOT NULL,
  stock_quantity INTEGER,
  ever_available_at BIGINT,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  UNIQUE(retailer_id, retailer_sku)
);

CREATE TABLE IF NOT EXISTS fatedrop_stock_observations (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES fatedrop_retail_offers(offer_id),
  retailer_id TEXT NOT NULL,
  observed_at BIGINT NOT NULL,
  stock_status TEXT NOT NULL,
  stock_confidence DOUBLE PRECISION NOT NULL,
  stock_quantity INTEGER,
  price_pence INTEGER,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS fatedrop_stock_observations_offer_time_idx ON fatedrop_stock_observations(offer_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_signals (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES fatedrop_products(id),
  offer_id TEXT NOT NULL REFERENCES fatedrop_retail_offers(offer_id),
  retailer_id TEXT NOT NULL,
  retailer_name TEXT NOT NULL,
  title TEXT NOT NULL,
  product_type TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  price_pence INTEGER,
  rrp_pence INTEGER,
  postage_pence INTEGER,
  delivered_price_pence INTEGER,
  markup_percent DOUBLE PRECISION,
  stock_status TEXT NOT NULL,
  previous_stock_status TEXT,
  confidence DOUBLE PRECISION NOT NULL,
  detected_at BIGINT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS fatedrop_signals_time_idx ON fatedrop_signals(detected_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_signals_state_time_idx ON fatedrop_signals(state, detected_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_retailer_health (
  retailer_id TEXT PRIMARY KEY,
  retailer_name TEXT NOT NULL,
  healthy BOOLEAN NOT NULL DEFAULT FALSE,
  last_scan_at BIGINT,
  last_success_at BIGINT,
  last_error TEXT,
  last_error_at BIGINT,
  products_seen INTEGER NOT NULL DEFAULT 0,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  baseline_completed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS fatedrop_signal_network_snapshots (
  id TEXT PRIMARY KEY,
  measured_at BIGINT NOT NULL,
  metrics JSONB NOT NULL,
  retailer_health JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS fatedrop_signal_network_snapshots_time_idx ON fatedrop_signal_network_snapshots(measured_at DESC);
