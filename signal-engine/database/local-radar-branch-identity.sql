-- FateDrop Local Radar branch identity migration.
-- Tested on Neon temporary branch br-noisy-sound-axkmjr00 before production application.
-- Purpose: align exact physical branch identity and store-scoped signal events with
-- the canonical retailer registry, removing the legacy empty fatedrop_retailers FK.

ALTER TABLE fatedrop_retailer_locations
  DROP CONSTRAINT IF EXISTS fatedrop_retailer_locations_retailer_id_fkey;

ALTER TABLE fatedrop_retailer_locations
  ADD CONSTRAINT fatedrop_retailer_locations_retailer_id_fkey
  FOREIGN KEY (retailer_id)
  REFERENCES fatedrop_retailer_registry(retailer_id)
  NOT VALID;

ALTER TABLE fatedrop_retailer_locations
  VALIDATE CONSTRAINT fatedrop_retailer_locations_retailer_id_fkey;

ALTER TABLE fatedrop_signal_events
  DROP CONSTRAINT IF EXISTS fatedrop_signal_events_retailer_id_fkey;

ALTER TABLE fatedrop_signal_events
  ADD CONSTRAINT fatedrop_signal_events_retailer_id_fkey
  FOREIGN KEY (retailer_id)
  REFERENCES fatedrop_retailer_registry(retailer_id)
  NOT VALID;

ALTER TABLE fatedrop_signal_events
  VALIDATE CONSTRAINT fatedrop_signal_events_retailer_id_fkey;

CREATE INDEX IF NOT EXISTS fatedrop_signal_events_local_radar_idx
  ON fatedrop_signal_events (location_id, occurred_at DESC, kind)
  WHERE location_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_retailer_locations_provider_identity_idx
  ON fatedrop_retailer_locations (provider, provider_id)
  WHERE provider_id IS NOT NULL;
