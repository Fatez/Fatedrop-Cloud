-- Fate Trader v1: Safe Exchange database-boundary integrity hardening.
-- Apply immediately after fate-trader-trust-safe-exchange.sql.
--
-- This file deliberately duplicates/replaces a small number of trigger functions from
-- the base migration so the release can be reviewed as an additive hardening layer.
-- No production migration has been applied.

-- A committed asset must point to the exact canonical FateDrop card identity recorded
-- on the source collection lot as well as the exact raw/graded physical state.
CREATE OR REPLACE FUNCTION fatedrop_validate_safe_exchange_commitment_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  committed RECORD;
  item RECORD;
  committed_fate_card_id TEXT;
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
    SELECT i.card_identity_id, i.copy_state, i.condition_code, c.user_id,
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

    committed_fate_card_id := NULLIF(committed.asset ->> 'fateCardId', '');
    committed_copy_state := lower(COALESCE(committed.asset ->> 'copyState', ''));
    committed_condition := lower(NULLIF(committed.asset ->> 'conditionCode', ''));
    committed_grading_company := NULLIF(committed.asset ->> 'gradingCompany', '');
    committed_grade_text := NULLIF(committed.asset ->> 'gradeValue', '');
    committed_grade := NULL;

    IF committed_fate_card_id IS DISTINCT FROM item.card_identity_id THEN
      RAISE EXCEPTION 'Committed canonical card identity does not match the collection item'
        USING ERRCODE = 'FTR05';
    END IF;

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

-- Once an agreement exists, its parties, exchange method, committed assets/cash, hub and
-- agreement hash are immutable. State-machine fields remain independently updateable.
CREATE OR REPLACE FUNCTION fatedrop_guard_safe_exchange_terms_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.party_a_user_id IS DISTINCT FROM OLD.party_a_user_id
     OR NEW.party_b_user_id IS DISTINCT FROM OLD.party_b_user_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.hub_id IS DISTINCT FROM OLD.hub_id
     OR NEW.party_a_commitment_json IS DISTINCT FROM OLD.party_a_commitment_json
     OR NEW.party_b_commitment_json IS DISTINCT FROM OLD.party_b_commitment_json
     OR NEW.agreement_hash IS DISTINCT FROM OLD.agreement_hash THEN
    RAISE EXCEPTION 'Safe Exchange agreed terms are immutable after creation'
      USING ERRCODE = 'FTR06';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_guard_terms_trigger
  ON fatedrop_safe_exchanges;
CREATE TRIGGER fatedrop_safe_exchange_guard_terms_trigger
BEFORE UPDATE OF party_a_user_id, party_b_user_id, method, hub_id,
                 party_a_commitment_json, party_b_commitment_json, agreement_hash
ON fatedrop_safe_exchanges
FOR EACH ROW
EXECUTE FUNCTION fatedrop_guard_safe_exchange_terms_mutation();

-- The physical/canonical identity of a reserved collection lot may not change beneath an
-- active agreement. Quantity may increase, but it cannot fall below the reserved total.
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
    OR NEW.card_identity_id IS DISTINCT FROM OLD.card_identity_id
    OR NEW.copy_state IS DISTINCT FROM OLD.copy_state
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
BEFORE UPDATE OF card_identity_id, copy_state, quantity, trade_quantity, status, condition_code
ON fatedrop_collection_items
FOR EACH ROW
EXECUTE FUNCTION fatedrop_guard_reserved_collection_item_mutation();

-- Grading data is stored separately from the collection item, so it needs its own lock.
-- Any grading insert/update/delete against a reserved physical lot is rejected until the
-- exchange becomes terminal and the reservation is released or consumed.
CREATE OR REPLACE FUNCTION fatedrop_guard_reserved_grading_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_item_id TEXT;
  reserved_quantity INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_item_id := OLD.collection_item_id;
  ELSE
    target_item_id := NEW.collection_item_id;
  END IF;

  SELECT COALESCE(SUM(r.quantity), 0)::INTEGER
    INTO reserved_quantity
  FROM fatedrop_safe_exchange_reservations r
  WHERE r.collection_item_id = target_item_id
    AND r.status = 'active';

  IF reserved_quantity > 0 THEN
    RAISE EXCEPTION 'Grading details are reserved by an active Safe Exchange'
      USING ERRCODE = 'FTR03';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fatedrop_safe_exchange_guard_grading_mutation_trigger
  ON fatedrop_collection_grading;
CREATE TRIGGER fatedrop_safe_exchange_guard_grading_mutation_trigger
BEFORE INSERT OR UPDATE OR DELETE ON fatedrop_collection_grading
FOR EACH ROW
EXECUTE FUNCTION fatedrop_guard_reserved_grading_mutation();
