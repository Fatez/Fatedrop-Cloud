-- Fate Collections: explicitly tracked set binders.
--
-- Ownership continues to live exclusively in fatedrop_collection_items. This
-- table records only the user's decision to monitor a set before (or after)
-- owning a raw card. It never stores card quantities, completion, or value.

CREATE TABLE IF NOT EXISTS fatedrop_collection_set_binders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL REFERENCES fatedrop_card_sets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'tracked'
    CHECK (status IN ('tracked', 'removed')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, set_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_set_binders_user_idx
  ON fatedrop_collection_set_binders(user_id, updated_at DESC)
  WHERE status = 'tracked';

CREATE INDEX IF NOT EXISTS fatedrop_collection_set_binders_set_idx
  ON fatedrop_collection_set_binders(set_id, user_id)
  WHERE status = 'tracked';
