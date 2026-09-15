-- Edition-aware collection binders.
-- Legacy rows remain `unspecified`; they are never silently reclassified as
-- Unlimited. Users explicitly choose a print run when starting a new binder.

ALTER TABLE fatedrop_collection_set_binders
  ADD COLUMN IF NOT EXISTS edition_code TEXT NOT NULL DEFAULT 'unspecified';

ALTER TABLE fatedrop_collection_set_completion_assertions
  ADD COLUMN IF NOT EXISTS edition_code TEXT NOT NULL DEFAULT 'unspecified';

ALTER TABLE fatedrop_collection_set_binders
  DROP CONSTRAINT IF EXISTS fatedrop_collection_set_binders_user_id_set_id_key;

ALTER TABLE fatedrop_collection_set_completion_assertions
  DROP CONSTRAINT IF EXISTS fatedrop_collection_set_completion_assertions_user_id_set_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_collection_set_binders_user_set_edition_uidx
  ON fatedrop_collection_set_binders(user_id,set_id,edition_code);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_collection_set_completion_user_set_edition_uidx
  ON fatedrop_collection_set_completion_assertions(user_id,set_id,edition_code);

CREATE INDEX IF NOT EXISTS fatedrop_collection_set_binders_user_edition_idx
  ON fatedrop_collection_set_binders(user_id,edition_code,updated_at DESC)
  WHERE status='tracked';
