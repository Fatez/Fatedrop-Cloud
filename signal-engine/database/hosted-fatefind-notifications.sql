-- FateDrop hosted FateFind / FateMatch delivery foundation
-- Additive only. This migration has been tested and applied to the shared production Postgres database.

CREATE TABLE IF NOT EXISTS fatedrop_hosted_fate_matches (
  id text PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  fate_find_id text NOT NULL,
  user_id text NOT NULL,
  signal_offer_id text NOT NULL,
  signal_product_id text NOT NULL,
  retailer_id text NOT NULL,
  retailer_name text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  item_price_pence bigint,
  postage_pence bigint,
  delivered_price_pence bigint,
  rrp_pence bigint,
  percent_above_rrp double precision,
  stock_status text NOT NULL,
  reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_at bigint NOT NULL,
  last_observed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS fatedrop_hosted_matches_user_time_idx ON fatedrop_hosted_fate_matches(user_id, matched_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_hosted_matches_find_time_idx ON fatedrop_hosted_fate_matches(fate_find_id, matched_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_push_endpoints (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL UNIQUE,
  platform text,
  device_label text,
  enabled boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_success_at bigint,
  last_failure_at bigint,
  failure_reason text
);
CREATE INDEX IF NOT EXISTS fatedrop_push_endpoints_user_idx ON fatedrop_push_endpoints(user_id, enabled);

CREATE TABLE IF NOT EXISTS fatedrop_notification_outbox (
  id text PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  user_id text NOT NULL,
  event_type text NOT NULL,
  event_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web','push','discord')),
  title text NOT NULL,
  body text NOT NULL,
  url text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  sent_at bigint,
  last_error text
);
CREATE INDEX IF NOT EXISTS fatedrop_outbox_pending_idx ON fatedrop_notification_outbox(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS fatedrop_outbox_user_time_idx ON fatedrop_notification_outbox(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_notification_delivery_attempts (
  id text PRIMARY KEY,
  outbox_id text NOT NULL REFERENCES fatedrop_notification_outbox(id) ON DELETE CASCADE,
  attempted_at bigint NOT NULL,
  result text NOT NULL,
  provider_message_id text,
  detail text
);
CREATE INDEX IF NOT EXISTS fatedrop_delivery_attempts_outbox_idx ON fatedrop_notification_delivery_attempts(outbox_id, attempted_at DESC);
