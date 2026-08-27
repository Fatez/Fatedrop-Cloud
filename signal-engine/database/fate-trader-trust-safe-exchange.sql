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
-- - The committed raw/graded state, raw condition, or graded company/value must match
--   canonical collection truth at agreement creation; vague or invented card state fails closed.
-- - Active reservations also protect the source collection lot from being removed or
--   reduced below its committed quantity; completed exchanges consume the outgoing lot.

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

-- Bind the human-visible agreement to the collection record that actually exists. This
-- is separate from quantity reservation because the agreement also carries raw/graded
-- state and condition/grade claims. A direct database writer cannot bypass this check.
CREATE OR REPLACE FUNCTION fatedrop_validate_safe_exchange_commitment_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  committed RECORD;
  item RECORD;
  committed_copy_state TEXT;
  committed_condition TEXT;
  committed_grading_company TEXT;
  committed_grade_text TEXT;
  committed_grade NUMERIC;
BEGIN
  FOR committed IN
    SELECT NEW.party_a_user_id AS user_id, asset
    FROM jsonb_array_elements(COALESCE(NEW.party_a_commitment_json -> 'assets', '[]'::jsonb)) AS asset
    UNION ALL
    SELECT NEW.party_b_user_id AS user_id, asset
    FROM jsonb_array_elements(COALESCE(NEW.party_b_commitment_json -> 'assets', '[]'::jsonb)) AS asset
  LOOP
    SELECT i.copy_state, i.condition_code, c.user_id,
           g.grading_company, g.grade_value
      INTO item
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id = i.collection_id
    LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id = i.id
    WHERE i.id = NULLIF(committed.asset ->> 'collectionItemId', '')
      AND i.status = 'active';

    IF NOT FOUND OR item.user_id <> committed.user_id THEN
      RAISE EXCEPTION 'Committed collection item is not available to this trader'
        USING ERRCODE = 'FTR02';
    END IF;

    committed_copy_state := lower(COALESCE(committed.asset ->> 'copyState', ''));
    committed_condition := lower(NULLIF(committed.asset ->> 'conditionCode', ''));
    committed_grading_company := NULLIF(committed.asset ->> 'gradingCompany', '');
    committed_grade_text := NULLIF(committed.asset ->> 'gradeValue', '');
    committed_grade := NULL;

    IF committed_copy_state <> item.copy_state THEN
      RAISE EXCEPTION 'Committed card state does not match the collection item'
        USING ERRCODE = 'FTR05';
    END IF;

    IF item.copy_state = 'raw' THEN
      IF committed_condition IS DISTINCT FROM item.condition_code
         OR committed_grading_company IS NOT NULL
         OR committed_grade_text IS NOT NULL THEN
        RAISE EXCEPTION 'Committed raw card condition does not match the collection item'
          USING ERRCODE = 'FTR05';
      END IF;
    ELSIF item.copy_state = 'graded' THEN
      IF committed_condition IS NOT NULL
         OR committed_grading_company IS DISTINCT FROM item.grading_company
         OR committed_grade_text IS NULL
         OR committed_grade_text !~ '^[0-9]+([.][0-9]+)?$' THEN
        RAISE EXCEPTION 'Committed graded card details do not match the collection item'
          USING ERRCODE = 'FTR05';
      END IF;
      committed_grade := committed_grade_text::NUMERIC;
      IF committed_grade IS DISTINCT FROM item.grade_value THEN
        RAISE EXCEPTION 'Committed graded card value does not match the collection item'
          USING ERRCODE = 'FTR05';
      END IF;
    ELSE
      RAISE EXCEPTION 'Collection item has an unsupported copy state'
        USING ERRCODE = 'FTR05';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_validate_state_trigger
  ON fatedrop_safe_exchanges;
CREATE TRIGGER fatedrop_safe_exchange_validate_state_trigger
BEFORE INSERT ON fatedrop_safe_exchanges
FOR EACH ROW
EXECUTE FUNCTION fatedrop_validate_safe_exchange_commitment_state();

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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  PRIMARY KEY (exchange_id, collection_item_id),
  CHECK ((status = 'active' AND resolved_at IS NULL) OR (status IN ('released', 'consumed') AND resolved_at IS NOT NULL))
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
      (exchange_id, collection_item_id, user_id, quantity, status, created_at, resolved_at)
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

CREATE OR REPLACE FUNCTION fatedrop_guard_reserved_collection_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reserved_quantity INTEGER;
BEGIN
  SELECT COALESCE(SUM(r.quantity), 0)::INTEGER
    INTO reserved_quantity
  FROM fatedrop_safe_exchange_reservations r
  WHERE r.collection_item_id = OLD.id
    AND r.status = 'active';

  IF reserved_quantity > 0 AND (
    NEW.status <> 'active'
    OR NEW.quantity < reserved_quantity
    OR NEW.trade_quantity < reserved_quantity
    OR NEW.condition_code IS DISTINCT FROM OLD.condition_code
  ) THEN
    RAISE EXCEPTION 'Collection item has card state or quantity reserved by an active Safe Exchange'
      USING ERRCODE = 'FTR03';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_guard_collection_mutation_trigger
  ON fatedrop_collection_items;
CREATE TRIGGER fatedrop_safe_exchange_guard_collection_mutation_trigger
BEFORE UPDATE OF quantity, trade_quantity, status, condition_code ON fatedrop_collection_items
FOR EACH ROW
EXECUTE FUNCTION fatedrop_guard_reserved_collection_item_mutation();

CREATE OR REPLACE FUNCTION fatedrop_resolve_safe_exchange_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reservation RECORD;
  item RECORD;
  next_quantity INTEGER;
  next_trade_quantity INTEGER;
  next_status TEXT;
  collection_event_type TEXT;
BEGIN
  IF NEW.state = 'cancelled' THEN
    UPDATE fatedrop_safe_exchange_reservations
    SET status = 'released', resolved_at = NEW.updated_at
    WHERE exchange_id = NEW.id
      AND status = 'active';
    RETURN NEW;
  END IF;

  IF NEW.state <> 'completed' THEN
    RETURN NEW;
  END IF;

  FOR reservation IN
    SELECT *
    FROM fatedrop_safe_exchange_reservations
    WHERE exchange_id = NEW.id
      AND status = 'active'
    ORDER BY collection_item_id
    FOR UPDATE
  LOOP
    SELECT i.id, i.quantity, i.trade_quantity, i.status, i.revision
      INTO item
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id = i.collection_id
    WHERE i.id = reservation.collection_item_id
      AND c.user_id = reservation.user_id
    FOR UPDATE OF i;

    IF NOT FOUND OR item.status <> 'active' OR item.quantity < reservation.quantity OR item.trade_quantity < reservation.quantity THEN
      RAISE EXCEPTION 'Reserved collection item is no longer valid for Safe Exchange completion'
        USING ERRCODE = 'FTR04';
    END IF;

    UPDATE fatedrop_safe_exchange_reservations
    SET status = 'consumed', resolved_at = NEW.updated_at
    WHERE exchange_id = NEW.id
      AND collection_item_id = reservation.collection_item_id
      AND status = 'active';

    IF reservation.quantity >= item.quantity THEN
      next_quantity := item.quantity;
      next_trade_quantity := 0;
      next_status := 'removed';
      collection_event_type := 'removed';
    ELSE
      next_quantity := item.quantity - reservation.quantity;
      next_trade_quantity := GREATEST(0, item.trade_quantity - reservation.quantity);
      next_status := 'active';
      collection_event_type := 'updated';
    END IF;

    UPDATE fatedrop_collection_items
    SET quantity = next_quantity,
        trade_quantity = next_trade_quantity,
        status = next_status,
        revision = revision + 1,
        updated_at = NEW.updated_at
    WHERE id = reservation.collection_item_id;

    INSERT INTO fatedrop_collection_item_events
      (id, user_id, collection_item_id, event_type, before_json, after_json, occurred_at)
    VALUES (
      'ftse_' || md5(NEW.id || ':' || reservation.collection_item_id || ':completed'),
      reservation.user_id,
      reservation.collection_item_id,
      collection_event_type,
      jsonb_build_object(
        'quantity', item.quantity,
        'tradeQuantity', item.trade_quantity,
        'status', item.status,
        'revision', item.revision
      ),
      jsonb_build_object(
        'quantity', next_quantity,
        'tradeQuantity', next_trade_quantity,
        'status', next_status,
        'revision', item.revision + 1
      ),
      NEW.updated_at
    )
    ON CONFLICT (id) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_resolve_reservations_trigger
  ON fatedrop_safe_exchanges;
CREATE TRIGGER fatedrop_safe_exchange_resolve_reservations_trigger
AFTER UPDATE OF state ON fatedrop_safe_exchanges
FOR EACH ROW
WHEN (
  OLD.state IS DISTINCT FROM NEW.state
  AND NEW.state IN ('completed', 'cancelled')
)
EXECUTE FUNCTION fatedrop_resolve_safe_exchange_reservations();

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
