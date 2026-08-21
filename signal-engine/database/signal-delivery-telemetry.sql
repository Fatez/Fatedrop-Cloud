-- Additive telemetry for public FateDrop lifecycle deliveries.
-- This table records delivery evidence only; it does not enqueue, retry, or send alerts.
-- Apply deliberately before deploying code that writes these rows.

CREATE TABLE IF NOT EXISTS fatedrop_signal_delivery_attempts (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES fatedrop_signals(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord')),
  attempted_at BIGINT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('sent', 'failed', 'skipped')),
  provider_message_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS fatedrop_signal_delivery_attempts_signal_time_idx
  ON fatedrop_signal_delivery_attempts(signal_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_signal_delivery_attempts_channel_time_idx
  ON fatedrop_signal_delivery_attempts(channel, attempted_at DESC);
