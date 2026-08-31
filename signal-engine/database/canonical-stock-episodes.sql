-- Canonical stock episodes and the FateDrop-owned lifecycle delivery ledger.
--
-- Additive migration. It deliberately does not backfill historical signals:
-- old rows must not suddenly become new Discord/push obligations.

CREATE TABLE IF NOT EXISTS fatedrop_stock_episodes (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL DEFAULT 'online' CHECK (scope_type IN ('online', 'physical')),
  scope_key TEXT NOT NULL,
  offer_id TEXT REFERENCES fatedrop_retail_offers(offer_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES fatedrop_products(id) ON DELETE CASCADE,
  retailer_id TEXT NOT NULL,
  location_id TEXT,
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  episode_state TEXT NOT NULL CHECK (episode_state IN ('evidence_open', 'available', 'closed')),
  availability_state TEXT NOT NULL CHECK (availability_state IN ('never_manifested', 'available', 'vanished')),
  opened_at BIGINT NOT NULL,
  manifested_at BIGINT,
  vanished_at BIGINT,
  latest_event_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(scope_type, scope_key, cycle_number),
  CHECK (
    (availability_state='never_manifested' AND episode_state='evidence_open' AND manifested_at IS NULL AND vanished_at IS NULL)
    OR (availability_state='available' AND episode_state='available' AND manifested_at IS NOT NULL AND vanished_at IS NULL)
    OR (availability_state='vanished' AND episode_state='closed' AND manifested_at IS NOT NULL AND vanished_at IS NOT NULL AND vanished_at >= manifested_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_stock_episodes_one_open_scope_idx
  ON fatedrop_stock_episodes(scope_type, scope_key)
  WHERE episode_state <> 'closed';

CREATE INDEX IF NOT EXISTS fatedrop_stock_episodes_offer_cycle_idx
  ON fatedrop_stock_episodes(offer_id, cycle_number DESC);

CREATE TABLE IF NOT EXISTS fatedrop_stock_episode_events (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES fatedrop_stock_episodes(id) ON DELETE CASCADE,
  signal_id TEXT NOT NULL UNIQUE REFERENCES fatedrop_signals(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('whisper', 'echo', 'manifested', 'vanished')),
  availability_effect TEXT NOT NULL CHECK (availability_effect IN ('none', 'available', 'unavailable')),
  signal_kind TEXT,
  occurred_at BIGINT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  CHECK (
    (stage IN ('whisper','echo') AND availability_effect='none')
    OR (stage='manifested' AND availability_effect='available')
    OR (stage='vanished' AND availability_effect='unavailable')
  )
);

CREATE INDEX IF NOT EXISTS fatedrop_stock_episode_events_episode_time_idx
  ON fatedrop_stock_episode_events(episode_id, occurred_at ASC);

CREATE OR REPLACE FUNCTION fatedrop_enforce_stock_episode_event_truth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  episode fatedrop_stock_episodes%ROWTYPE;
BEGIN
  SELECT * INTO episode FROM fatedrop_stock_episodes WHERE id=NEW.episode_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical stock episode % does not exist', NEW.episode_id;
  END IF;

  IF NEW.stage='manifested' AND (
    episode.availability_state NOT IN ('available','vanished')
    OR episode.manifested_at IS NULL
    OR episode.manifested_at > NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'Manifested event is inconsistent with canonical episode %', NEW.episode_id;
  END IF;

  IF NEW.stage='vanished' AND (
    episode.episode_state <> 'closed'
    OR episode.availability_state <> 'vanished'
    OR episode.manifested_at IS NULL
    OR episode.vanished_at IS NULL
    OR episode.vanished_at <> NEW.occurred_at
    OR NOT EXISTS (
      SELECT 1
      FROM fatedrop_stock_episode_events prior
      WHERE prior.episode_id=NEW.episode_id
        AND prior.stage='manifested'
        AND prior.occurred_at <= NEW.occurred_at
    )
  ) THEN
    RAISE EXCEPTION 'Vanished requires prior canonical Manifested availability in episode %', NEW.episode_id;
  END IF;

  IF NEW.stage IN ('whisper','echo')
     AND episode.episode_state='closed'
     AND NEW.occurred_at > episode.vanished_at THEN
    RAISE EXCEPTION 'Evidence after Vanished must start a new canonical episode';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_stock_episode_event_truth_trigger ON fatedrop_stock_episode_events;
CREATE TRIGGER fatedrop_stock_episode_event_truth_trigger
BEFORE INSERT OR UPDATE ON fatedrop_stock_episode_events
FOR EACH ROW EXECUTE FUNCTION fatedrop_enforce_stock_episode_event_truth();

CREATE TABLE IF NOT EXISTS fatedrop_stock_episode_conflicts (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('online', 'physical')),
  scope_key TEXT NOT NULL,
  offer_id TEXT,
  product_id TEXT,
  retailer_id TEXT,
  stage TEXT,
  reason TEXT NOT NULL,
  occurred_at BIGINT,
  signal_payload JSONB NOT NULL,
  resolution_state TEXT NOT NULL DEFAULT 'pending' CHECK (resolution_state IN ('pending', 'ignored', 'resolved')),
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS fatedrop_stock_episode_conflicts_pending_idx
  ON fatedrop_stock_episode_conflicts(resolution_state, created_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_signal_delivery_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  signal_id TEXT NOT NULL REFERENCES fatedrop_signals(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES fatedrop_stock_episodes(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'push')),
  destination_key TEXT NOT NULL,
  delivery_policy TEXT NOT NULL CHECK (delivery_policy IN ('interrupt', 'inbox_only', 'history_only', 'anomaly_quarantine')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'provider_accepted', 'retryable', 'suppressed', 'outcome_unknown', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  lease_token TEXT,
  lease_expires_at BIGINT,
  provider_message_id TEXT,
  accepted_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_error TEXT,
  UNIQUE(signal_id, channel, destination_key),
  CHECK (
    (state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state<>'claimed' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS fatedrop_signal_delivery_outbox_ready_idx
  ON fatedrop_signal_delivery_outbox(state, available_at, expires_at, created_at)
  WHERE state IN ('pending', 'retryable');

CREATE INDEX IF NOT EXISTS fatedrop_signal_delivery_outbox_episode_idx
  ON fatedrop_signal_delivery_outbox(episode_id, created_at ASC);

CREATE TABLE IF NOT EXISTS fatedrop_signal_delivery_outbox_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES fatedrop_signal_delivery_outbox(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  result TEXT NOT NULL CHECK (result IN ('provider_accepted', 'retryable_failure', 'terminal_failure', 'suppressed', 'outcome_unknown')),
  provider_message_id TEXT,
  detail TEXT,
  UNIQUE(outbox_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS fatedrop_signal_delivery_outbox_attempts_time_idx
  ON fatedrop_signal_delivery_outbox_attempts(outbox_id, started_at DESC);
