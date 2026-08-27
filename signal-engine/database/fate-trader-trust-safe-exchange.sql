-- Fate Trader v1: FateTrust evidence + Safe Exchange persistence.
-- Apply after Fate Trader card identity, collection, and binder migrations.
--
-- Design rules:
-- - Trust is derived from server-owned evidence; unsubstantiated evidence may be retained
--   for audit but never affects the score.
-- - A Fate Hub is an explicitly approved physical retailer location. Being present in
--   Local Radar does not make a location a Fate Hub.
-- - Hub sessions are short-lived and bound to one exchange + one approved hub.
-- - Safe Exchange terms are stored atomically and transitions are append-only audited.
-- - Collection quantities committed to a non-terminal Safe Exchange are reserved at
--   the database boundary so one physical lot cannot be overcommitted concurrently.

CREATE TABLE IF NOT EXISTS fatedrop_fate_hubs (
  id TEXT PRIMARY KEY REFERENCES fatedrop_retailer_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'suspended', 'retired')),
  approved_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_fate_hubs_status_idx
  ON fatedrop_fate_hubs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS fatedrop_safe_exchanges (
  id TEXT PRIMARY KEY,
  party_a_user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE RESTRICT,
  party_b_user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('hub', 'postal')),
  hub_id TEXT REFERENCES fatedrop_fate_hubs(id) ON DELETE RESTRICT,
  party_a_commitment_json JSONB NOT NULL,
  party_b_commitment_json JSONB NOT NULL,
  agreement_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'agreed', 'checked_in', 'in_transit', 'inspected', 'confirming', 'completed', 'cancelled')),
  party_a_agreed BOOLEAN NOT NULL DEFAULT false,
  party_b_agreed BOOLEAN NOT NULL DEFAULT false,
  party_a_checked_in BOOLEAN NOT NULL DEFAULT false,
  party_b_checked_in BOOLEAN NOT NULL DEFAULT false,
  party_a_tracking_ref TEXT,
  party_b_tracking_ref TEXT,
  party_a_delivered BOOLEAN NOT NULL DEFAULT false,
  party_b_delivered BOOLEAN NOT NULL DEFAULT false,
  party_a_inspected BOOLEAN NOT NULL DEFAULT false,
  party_b_inspected BOOLEAN NOT NULL DEFAULT false,
  party_a_confirmed BOOLEAN NOT NULL DEFAULT false,
  party_b_confirmed BOOLEAN NOT NULL DEFAULT false,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  cancelled_at BIGINT,
  CHECK (party_a_user_id <> party_b_user_id),
  CHECK ((method = 'hub' AND hub_id IS NOT NULL) OR (method = 'postal' AND hub_id IS NULL))
);

CREATE INDEX IF NOT EXISTS fatedrop_safe_exchanges_party_a_idx
  ON fatedrop_safe_exchanges(party_a_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_safe_exchanges_party_b_idx
  ON fatedrop_safe_exchanges(party_b_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_safe_exchanges_active_idx
  ON fatedrop_safe_exchanges(state, updated_at DESC)
  WHERE state NOT IN ('completed', 'cancelled');

-- Quantity-aware reservations are intentionally separate from the immutable agreement
-- JSON. Every exchange gets at most one reservation row per collection lot. Multiple
-- copies from the same lot are represented by quantity. The trigger below locks the
-- collection item before checking the active reservation total, which serializes two
-- concurrent attempts to reserve the same physical lot.
CREATE TABLE IF NOT EXISTS fatedrop_safe_exchange_reservations (
  exchange_id TEXT NOT NULL REFERENCES fatedrop_safe_exchanges(id) ON DELETE CASCADE,
  collection_item_id TEXT NOT NULL REFERENCES fatedrop_collection_items(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at BIGINT NOT NULL,
  released_at BIGINT,
  PRIMARY KEY (exchange_id, collection_item_id),
  CHECK ((status = 'active' AND released_at IS NULL) OR (status = 'released' AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS fatedrop_safe_exchange_reservations_item_active_idx
  ON fatedrop_safe_exchange_reservations(collection_item_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS fatedrop_safe_exchange_reservations_exchange_idx
  ON fatedrop_safe_exchange_reservations(exchange_id, status);

CREATE OR REPLACE FUNCTION fatedrop_reserve_safe_exchange_commitments()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reservation RECORD;
  actual_owner_user_id TEXT;
  available_trade_quantity INTEGER;
  already_reserved_quantity INTEGER;
BEGIN
  FOR reservation IN
    WITH commitment_assets AS (
      SELECT
        NEW.party_a_user_id AS user_id,
        NULLIF(asset ->> 'collectionItemId', '') AS collection_item_id,
        COALESCE(NULLIF(asset ->> 'quantity', '')::INTEGER, 0) AS quantity
      FROM jsonb_array_elements(COALESCE(NEW.party_a_commitment_json -> 'assets', '[]'::jsonb)) AS asset
      UNION ALL
      SELECT
        NEW.party_b_user_id AS user_id,
        NULLIF(asset ->> 'collectionItemId', '') AS collection_item_id,
        COALESCE(NULLIF(asset ->> 'quantity', '')::INTEGER, 0) AS quantity
      FROM jsonb_array_elements(COALESCE(NEW.party_b_commitment_json -> 'assets', '[]'::jsonb)) AS asset
    )
    SELECT user_id, collection_item_id, SUM(quantity)::INTEGER AS quantity
    FROM commitment_assets
    GROUP BY user_id, collection_item_id
    ORDER BY collection_item_id, user_id
  LOOP
    IF reservation.collection_item_id IS NULL OR reservation.quantity <= 0 THEN
      RAISE EXCEPTION 'Safe Exchange commitment contains an invalid collection reservation'
        USING ERRCODE = 'FTR02';
    END IF;

    -- Locking the physical lot makes the subsequent SUM + INSERT deterministic under
    -- concurrent exchange creation. Every writer follows the same item-id order above
    -- to avoid cross-lot deadlocks.
    SELECT c.user_id, i.trade_quantity
      INTO actual_owner_user_id, available_trade_quantity
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id = i.collection_id
    WHERE i.id = reservation.collection_item_id
      AND i.status = 'active'
    FOR UPDATE OF i;

    IF NOT FOUND OR actual_owner_user_id <> reservation.user_id THEN
      RAISE EXCEPTION 'Safe Exchange collection ownership changed before reservation'
        USING ERRCODE = 'FTR02';
    END IF;

    SELECT COALESCE(SUM(r.quantity), 0)::INTEGER
      INTO already_reserved_quantity
    FROM fatedrop_safe_exchange_reservations r
    WHERE r.collection_item_id = reservation.collection_item_id
      AND r.status = 'active';

    IF already_reserved_quantity + reservation.quantity > available_trade_quantity THEN
      RAISE EXCEPTION 'Collection item quantity is already committed to another active Safe Exchange'
        USING ERRCODE = 'FTR01';
    END IF;

    INSERT INTO fatedrop_safe_exchange_reservations
      (exchange_id, collection_item_id, user_id, quantity, status, created_at, released_at)
    VALUES
      (NEW.id, reservation.collection_item_id, reservation.user_id, reservation.quantity, 'active', NEW.created_at, NULL);
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_reserve_commitments_trigger
  ON fatedrop_safe_exchanges;
CREATE TRIGGER fatedrop_safe_exchange_reserve_commitments_trigger
AFTER INSERT ON fatedrop_safe_exchanges
FOR EACH ROW
EXECUTE FUNCTION fatedrop_reserve_safe_exchange_commitments();

CREATE OR REPLACE FUNCTION fatedrop_release_safe_exchange_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE fatedrop_safe_exchange_reservations
  SET status = 'released', released_at = NEW.updated_at
  WHERE exchange_id = NEW.id
    AND status = 'active';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_release_reservations_trigger
  ON fatedrop_safe_exchanges;
CREATE TRIGGER fatedrop_safe_exchange_release_reservations_trigger
AFTER UPDATE OF state ON fatedrop_safe_exchanges
FOR EACH ROW
WHEN (
  OLD.state IS DISTINCT FROM NEW.state
  AND NEW.state IN ('completed', 'cancelled')
)
EXECUTE FUNCTION fatedrop_release_safe_exchange_reservations();

CREATE TABLE IF NOT EXISTS fatedrop_safe_exchange_events (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES fatedrop_safe_exchanges(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES fatedrop_users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS fatedrop_safe_exchange_events_exchange_idx
  ON fatedrop_safe_exchange_events(exchange_id, occurred_at ASC);

CREATE TABLE IF NOT EXISTS fatedrop_hub_sessions (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES fatedrop_safe_exchanges(id) ON DELETE CASCADE,
  hub_id TEXT NOT NULL REFERENCES fatedrop_fate_hubs(id) ON DELETE RESTRICT,
  proof_token_hash TEXT NOT NULL UNIQUE,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL,
  CHECK (expires_at > issued_at),
  CHECK (expires_at - issued_at <= 900000)
);

CREATE INDEX IF NOT EXISTS fatedrop_hub_sessions_exchange_idx
  ON fatedrop_hub_sessions(exchange_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_hub_sessions_active_idx
  ON fatedrop_hub_sessions(hub_id, expires_at DESC)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS fatedrop_trader_trust_evidence (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT,
  user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE CASCADE,
  counterparty_user_id TEXT REFERENCES fatedrop_users(id) ON DELETE SET NULL,
  exchange_id TEXT REFERENCES fatedrop_safe_exchanges(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'hub_trade',
    'tracked_postal_trade',
    'dual_confirmed_trade',
    'failed_trade',
    'verified_positive_feedback',
    'substantiated_negative_feedback',
    'minor_fulfilment',
    'significant_dispute',
    'confirmed_fraud'
  )),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('verified', 'substantiated', 'unsubstantiated')),
  trade_value_pence INTEGER NOT NULL DEFAULT 0 CHECK (trade_value_pence >= 0),
  evidence_source TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (counterparty_user_id IS NULL OR counterparty_user_id <> user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_trader_trust_evidence_dedupe_idx
  ON fatedrop_trader_trust_evidence(dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS fatedrop_trader_trust_evidence_user_idx
  ON fatedrop_trader_trust_evidence(user_id, occurred_at ASC);
CREATE INDEX IF NOT EXISTS fatedrop_trader_trust_evidence_exchange_idx
  ON fatedrop_trader_trust_evidence(exchange_id)
  WHERE exchange_id IS NOT NULL;
