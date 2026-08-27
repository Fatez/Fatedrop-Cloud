-- Fate Trader v1: completed Safe Exchanges reconcile ownership on both sides.
-- Apply after fate-trader-trust-safe-exchange-integrity-hardening.sql.
--
-- Truth rules:
-- - completion is an atomic ownership transfer, not only a sender-side decrement;
-- - the receiver gets a new collection lot so sender history remains intact;
-- - canonical card identity and physical raw/graded state are copied from the locked source lot;
-- - received cards are NOT automatically offered for trade (trade_quantity = 0);
-- - sender-private notes and media are not copied;
-- - grading/certification metadata follows a graded physical slab;
-- - transfer provenance is durable and deterministic per exchange/source lot.

CREATE TABLE IF NOT EXISTS fatedrop_safe_exchange_transfers (
  exchange_id TEXT NOT NULL REFERENCES fatedrop_safe_exchanges(id) ON DELETE CASCADE,
  source_collection_item_id TEXT NOT NULL,
  received_collection_item_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE RESTRICT,
  to_user_id TEXT NOT NULL REFERENCES fatedrop_users(id) ON DELETE RESTRICT,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  transferred_at BIGINT NOT NULL,
  PRIMARY KEY (exchange_id, source_collection_item_id),
  UNIQUE (received_collection_item_id),
  CHECK (from_user_id <> to_user_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_safe_exchange_transfers_from_user_idx
  ON fatedrop_safe_exchange_transfers(from_user_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_safe_exchange_transfers_to_user_idx
  ON fatedrop_safe_exchange_transfers(to_user_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS fatedrop_safe_exchange_transfers_card_idx
  ON fatedrop_safe_exchange_transfers(card_identity_id, transferred_at DESC);

CREATE OR REPLACE FUNCTION fatedrop_resolve_safe_exchange_reservations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reservation RECORD;
  item RECORD;
  receiver_user_id TEXT;
  receiver_collection_id TEXT;
  receiver_item_id TEXT;
  next_quantity INTEGER;
  next_trade_quantity INTEGER;
  next_status TEXT;
  collection_event_type TEXT;
  receiver_grading_json JSONB;
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
    IF reservation.user_id = NEW.party_a_user_id THEN
      receiver_user_id := NEW.party_b_user_id;
    ELSIF reservation.user_id = NEW.party_b_user_id THEN
      receiver_user_id := NEW.party_a_user_id;
    ELSE
      RAISE EXCEPTION 'Safe Exchange reservation owner is not an exchange party'
        USING ERRCODE = 'FTR04';
    END IF;

    SELECT
      i.id,
      i.card_identity_id,
      i.quantity,
      i.trade_quantity,
      i.copy_state,
      i.condition_code,
      i.status,
      i.revision,
      ci.tcg_id,
      g.grading_company,
      g.grade_label,
      g.grade_value,
      g.certification_number,
      g.certification_status,
      g.verification_source,
      g.verified_at
      INTO item
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id = i.collection_id
    JOIN fatedrop_card_identities ci ON ci.id = i.card_identity_id
    LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id = i.id
    WHERE i.id = reservation.collection_item_id
      AND c.user_id = reservation.user_id
      AND ci.verification_status = 'verified'
    FOR UPDATE OF i;

    IF NOT FOUND
       OR item.status <> 'active'
       OR item.quantity < reservation.quantity
       OR item.trade_quantity < reservation.quantity THEN
      RAISE EXCEPTION 'Reserved collection item is no longer valid for Safe Exchange completion'
        USING ERRCODE = 'FTR04';
    END IF;

    IF item.copy_state = 'graded' AND (
      reservation.quantity <> 1
      OR item.grading_company IS NULL
      OR item.grade_label IS NULL
    ) THEN
      RAISE EXCEPTION 'Reserved graded collection item is incomplete for ownership transfer'
        USING ERRCODE = 'FTR04';
    END IF;

    -- Mark the reservation consumed first. The whole exchange update is one transaction,
    -- so any later reconciliation failure rolls this back together with the exchange state.
    UPDATE fatedrop_safe_exchange_reservations
    SET status = 'consumed', resolved_at = NEW.updated_at
    WHERE exchange_id = NEW.id
      AND collection_item_id = reservation.collection_item_id
      AND status = 'active';

    -- Each user owns one collection per TCG. A receiver may not have created one yet,
    -- so completion creates it atomically without depending on an App/Web write first.
    INSERT INTO fatedrop_collections
      (id, user_id, tcg_id, name, visibility, created_at, updated_at)
    VALUES (
      'fdcollection_trade_' || md5(receiver_user_id || ':' || item.tcg_id),
      receiver_user_id,
      item.tcg_id,
      'My Collection',
      'private',
      NEW.updated_at,
      NEW.updated_at
    )
    ON CONFLICT (user_id, tcg_id)
    DO UPDATE SET updated_at = GREATEST(fatedrop_collections.updated_at, EXCLUDED.updated_at)
    RETURNING id INTO receiver_collection_id;

    receiver_item_id := 'fditem_trade_' || md5(
      NEW.id || ':' || reservation.collection_item_id || ':' || receiver_user_id
    );

    INSERT INTO fatedrop_collection_items
      (id, collection_id, card_identity_id, quantity, trade_quantity, copy_state,
       condition_code, notes, status, revision, created_at, updated_at)
    VALUES (
      receiver_item_id,
      receiver_collection_id,
      item.card_identity_id,
      reservation.quantity,
      0,
      item.copy_state,
      item.condition_code,
      NULL,
      'active',
      1,
      NEW.updated_at,
      NEW.updated_at
    );

    receiver_grading_json := NULL;
    IF item.copy_state = 'graded' THEN
      INSERT INTO fatedrop_collection_grading
        (collection_item_id, grading_company, grade_label, grade_value,
         certification_number, certification_status, verification_source,
         verified_at, created_at, updated_at)
      VALUES (
        receiver_item_id,
        item.grading_company,
        item.grade_label,
        item.grade_value,
        item.certification_number,
        item.certification_status,
        item.verification_source,
        item.verified_at,
        NEW.updated_at,
        NEW.updated_at
      );

      receiver_grading_json := jsonb_build_object(
        'gradingCompany', item.grading_company,
        'gradeLabel', item.grade_label,
        'gradeValue', item.grade_value,
        'certificationNumber', item.certification_number,
        'certificationStatus', item.certification_status,
        'verificationSource', item.verification_source,
        'verifiedAt', item.verified_at
      );
    END IF;

    INSERT INTO fatedrop_safe_exchange_transfers
      (exchange_id, source_collection_item_id, received_collection_item_id,
       from_user_id, to_user_id, card_identity_id, quantity, transferred_at)
    VALUES (
      NEW.id,
      reservation.collection_item_id,
      receiver_item_id,
      reservation.user_id,
      receiver_user_id,
      item.card_identity_id,
      reservation.quantity,
      NEW.updated_at
    );

    INSERT INTO fatedrop_collection_item_events
      (id, user_id, collection_item_id, event_type, before_json, after_json, occurred_at)
    VALUES (
      'ftrecv_' || md5(NEW.id || ':' || reservation.collection_item_id || ':' || receiver_user_id),
      receiver_user_id,
      receiver_item_id,
      'created',
      NULL,
      jsonb_build_object(
        'id', receiver_item_id,
        'fateCardId', item.card_identity_id,
        'quantity', reservation.quantity,
        'tradeQuantity', 0,
        'copyState', item.copy_state,
        'conditionCode', item.condition_code,
        'notes', NULL,
        'status', 'active',
        'revision', 1,
        'grading', receiver_grading_json,
        'acquisitionMode', 'safe_exchange',
        'sourceExchangeId', NEW.id,
        'sourceCollectionItemId', reservation.collection_item_id,
        'sourceUserId', reservation.user_id
      ),
      NEW.updated_at
    );

    -- Preserve the sender-side audit semantics already established by the prior migration.
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

-- The trigger already exists from the Safe Exchange base migration and invokes the
-- function by name. Replacing the function above upgrades completion atomically without
-- changing the public state machine or any Web/App route.
