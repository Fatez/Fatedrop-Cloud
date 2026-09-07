-- Fate Collections: user-confirmed set checklist completion.
--
-- A completion assertion is deliberately printing-scoped. It records that the
-- user says the verified checklist was complete at a particular catalogue
-- snapshot; it does not invent an exact finish, language, condition, quantity,
-- card identity, or market value. Exact holdings remain exclusively in
-- fatedrop_collection_items.

CREATE TABLE IF NOT EXISTS fatedrop_collection_set_completion_assertions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  set_id TEXT NOT NULL REFERENCES fatedrop_card_sets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
  checklist_scope TEXT NOT NULL DEFAULT 'printing'
    CHECK (checklist_scope = 'printing'),
  printing_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(printing_ids) = 'array'),
  catalogue_fingerprint TEXT NOT NULL,
  confirmation_batch_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user_confirmed_checklist'
    CHECK (source = 'user_confirmed_checklist'),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, set_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_set_completion_user_idx
  ON fatedrop_collection_set_completion_assertions(user_id, updated_at DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS fatedrop_collection_set_completion_set_idx
  ON fatedrop_collection_set_completion_assertions(set_id, user_id)
  WHERE status = 'active';

-- Append-only audit evidence for confirmation/removal actions. The assertion
-- reference intentionally has no FK so its history survives future retention
-- or migration work.
CREATE TABLE IF NOT EXISTS fatedrop_collection_set_completion_events (
  id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('confirmed', 'refreshed', 'removed')),
  snapshot_json JSONB NOT NULL,
  occurred_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_collection_set_completion_events_user_idx
  ON fatedrop_collection_set_completion_events(user_id, occurred_at DESC);
