-- Fate Trader v1: personal collection and exact-card intent foundation.
-- Applied after fate-trader-card-identity.sql and fate-trader-catalogue-crosswalk.sql.
--
-- Collection items represent a homogeneous physical lot. Raw copies with the
-- same state may use quantity > 1. A graded slab is always quantity 1 because
-- certification and photographs describe one physical object.

CREATE TABLE IF NOT EXISTS fatedrop_collections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  tcg_id TEXT NOT NULL REFERENCES fatedrop_tcgs(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT 'My Collection',
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'network')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, tcg_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_collections_user_idx
  ON fatedrop_collections(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_collection_items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES fatedrop_collections(id) ON DELETE CASCADE,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  trade_quantity INTEGER NOT NULL DEFAULT 0 CHECK (trade_quantity >= 0 AND trade_quantity <= quantity),
  copy_state TEXT NOT NULL CHECK (copy_state IN ('raw', 'graded')),
  condition_code TEXT CHECK (condition_code IN ('mint', 'near_mint', 'lightly_played', 'moderately_played', 'heavily_played', 'damaged', 'unknown')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (copy_state <> 'graded' OR quantity = 1),
  CHECK (copy_state <> 'graded' OR condition_code IS NULL),
  CHECK (copy_state <> 'raw' OR condition_code IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_items_collection_idx
  ON fatedrop_collection_items(collection_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS fatedrop_collection_items_card_idx
  ON fatedrop_collection_items(card_identity_id, collection_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS fatedrop_collection_items_trade_idx
  ON fatedrop_collection_items(card_identity_id, trade_quantity)
  WHERE status = 'active' AND trade_quantity > 0;

CREATE TABLE IF NOT EXISTS fatedrop_collection_grading (
  collection_item_id TEXT PRIMARY KEY REFERENCES fatedrop_collection_items(id) ON DELETE CASCADE,
  grading_company TEXT NOT NULL,
  grade_label TEXT NOT NULL,
  grade_value NUMERIC,
  certification_number TEXT,
  certification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (certification_status IN ('unverified', 'verified', 'failed', 'unavailable')),
  verification_source TEXT,
  verified_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (grade_value IS NULL OR grade_value >= 0)
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_grading_cert_idx
  ON fatedrop_collection_grading(grading_company, certification_number)
  WHERE certification_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS fatedrop_collection_item_media (
  id TEXT PRIMARY KEY,
  collection_item_id TEXT NOT NULL REFERENCES fatedrop_collection_items(id) ON DELETE CASCADE,
  media_role TEXT NOT NULL CHECK (media_role IN ('front', 'back', 'certification', 'detail')),
  storage_key TEXT NOT NULL,
  media_status TEXT NOT NULL DEFAULT 'active' CHECK (media_status IN ('active', 'removed', 'quarantined')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_item_media_item_idx
  ON fatedrop_collection_item_media(collection_item_id, created_at);

-- Lightweight exact-card Want. Phase 3 adds structured constraints around this
-- same canonical relation instead of creating a second wishlist identity model.
CREATE TABLE IF NOT EXISTS fatedrop_card_wants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 999),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, card_identity_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_card_wants_active_card_idx
  ON fatedrop_card_wants(card_identity_id, user_id)
  WHERE active = true;

-- Append-only audit log. collection_item_id intentionally has no FK so history
-- survives future hard-deletion/retention operations.
CREATE TABLE IF NOT EXISTS fatedrop_collection_item_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  collection_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'removed', 'restored', 'trade_quantity_changed')),
  before_json JSONB,
  after_json JSONB,
  occurred_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_item_events_item_idx
  ON fatedrop_collection_item_events(collection_item_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_collection_item_events_user_idx
  ON fatedrop_collection_item_events(user_id, occurred_at DESC);
