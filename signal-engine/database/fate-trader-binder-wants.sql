-- Fate Trader v1: Trade Binder and structured exact-Want constraints.
-- Applied after fate-trader-collection.sql.
--
-- Ownership remains authoritative in fatedrop_collection_items. Binder rows add
-- trading intent and state only. They never mint or duplicate owned quantity.

CREATE TABLE IF NOT EXISTS fatedrop_trade_binders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  tcg_id TEXT NOT NULL REFERENCES fatedrop_tcgs(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT 'Trade Binder',
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'network')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  local_trade_allowed BOOLEAN NOT NULL DEFAULT true,
  postal_trade_allowed BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (local_trade_allowed OR postal_trade_allowed),
  UNIQUE(user_id, tcg_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_trade_binders_user_idx
  ON fatedrop_trade_binders(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_trade_binder_items (
  id TEXT PRIMARY KEY,
  binder_id TEXT NOT NULL REFERENCES fatedrop_trade_binders(id) ON DELETE CASCADE,
  collection_item_id TEXT NOT NULL REFERENCES fatedrop_collection_items(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'in_negotiation', 'reserved', 'traded', 'withdrawn')),
  trade_mode TEXT NOT NULL DEFAULT 'open'
    CHECK (trade_mode IN ('open', 'exact_wants_only', 'bundle_ok', 'one_for_one', 'negotiable')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'network')),
  local_trade_allowed BOOLEAN NOT NULL DEFAULT true,
  postal_trade_allowed BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (local_trade_allowed OR postal_trade_allowed),
  UNIQUE(collection_item_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_trade_binder_items_binder_idx
  ON fatedrop_trade_binder_items(binder_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_trade_binder_items_available_idx
  ON fatedrop_trade_binder_items(binder_id, status, updated_at DESC)
  WHERE status = 'available';

-- Constraints extend the exact canonical Want created in Phase 2. Language is
-- intentionally not duplicated here because exact fate_card_id already carries
-- language and finish variant identity.
CREATE TABLE IF NOT EXISTS fatedrop_want_constraints (
  want_id TEXT PRIMARY KEY REFERENCES fatedrop_card_wants(id) ON DELETE CASCADE,
  copy_state TEXT NOT NULL DEFAULT 'any'
    CHECK (copy_state IN ('any', 'raw', 'graded')),
  minimum_condition_code TEXT
    CHECK (minimum_condition_code IN ('mint', 'near_mint', 'lightly_played', 'moderately_played', 'heavily_played', 'damaged', 'unknown')),
  minimum_grade NUMERIC,
  maximum_grade NUMERIC,
  accepted_grading_companies JSONB NOT NULL DEFAULT '[]'::jsonb,
  local_trade_allowed BOOLEAN NOT NULL DEFAULT true,
  postal_trade_allowed BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (local_trade_allowed OR postal_trade_allowed),
  CHECK (minimum_grade IS NULL OR minimum_grade >= 0),
  CHECK (maximum_grade IS NULL OR maximum_grade >= 0),
  CHECK (minimum_grade IS NULL OR maximum_grade IS NULL OR minimum_grade <= maximum_grade),
  CHECK (copy_state <> 'raw' OR (minimum_grade IS NULL AND maximum_grade IS NULL))
);

CREATE INDEX IF NOT EXISTS fatedrop_want_constraints_trade_mode_idx
  ON fatedrop_want_constraints(local_trade_allowed, postal_trade_allowed);

-- Append-only binder audit. collection_item_id is retained in payload via the
-- binder item and ownership history. State changes never silently overwrite the
-- previous trading intent.
CREATE TABLE IF NOT EXISTS fatedrop_trade_binder_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  binder_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('created', 'updated', 'status_changed', 'withdrawn', 'restored')),
  before_json JSONB,
  after_json JSONB,
  occurred_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_trade_binder_events_item_idx
  ON fatedrop_trade_binder_events(binder_item_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_trade_binder_events_user_idx
  ON fatedrop_trade_binder_events(user_id, occurred_at DESC);
