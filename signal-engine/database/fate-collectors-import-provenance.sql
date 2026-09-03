-- Fate Collectors Project 2A: import-source provenance for collection items.
--
-- Canonical card identity remains owned by fatedrop_card_identities. Import
-- sources (Collectr CSV and future adapters) are evidence about how a user's
-- collection item entered FateDrop and MUST NOT become canonical card truth.

CREATE TABLE IF NOT EXISTS fatedrop_collection_item_sources (
  id TEXT PRIMARY KEY,
  collection_item_id TEXT NOT NULL REFERENCES fatedrop_collection_items(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_record_key TEXT NOT NULL,
  import_batch_key TEXT,
  observed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_collection_item_sources_identity_idx
  ON fatedrop_collection_item_sources(
    collection_item_id,
    source_name,
    source_record_key,
    COALESCE(import_batch_key, '')
  );

CREATE INDEX IF NOT EXISTS fatedrop_collection_item_sources_item_idx
  ON fatedrop_collection_item_sources(collection_item_id, created_at);

CREATE INDEX IF NOT EXISTS fatedrop_collection_item_sources_source_idx
  ON fatedrop_collection_item_sources(source_name, source_record_key);
