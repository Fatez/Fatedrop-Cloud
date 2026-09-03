-- Fate Collectors Project 2A: optional purchase-cost metadata.
--
-- Market value belongs to Fate Price. This table stores only what the collector
-- says they paid (or an imported equivalent) and never becomes market truth.

CREATE TABLE IF NOT EXISTS fatedrop_collection_item_cost_basis (
  collection_item_id TEXT PRIMARY KEY REFERENCES fatedrop_collection_items(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  price_scope TEXT NOT NULL CHECK (price_scope IN ('unit', 'lot')),
  acquired_at BIGINT,
  source_name TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_item_cost_basis_currency_idx
  ON fatedrop_collection_item_cost_basis(currency_code, updated_at DESC);
