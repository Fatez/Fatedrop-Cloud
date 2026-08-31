BEGIN;

UPDATE fatedrop_products
SET tcg = 'pokemon'
WHERE tcg IS NULL OR BTRIM(tcg) = '';

ALTER TABLE fatedrop_products
  ALTER COLUMN tcg SET DEFAULT 'pokemon',
  ALTER COLUMN tcg SET NOT NULL;

ALTER TABLE fatedrop_products
  DROP CONSTRAINT IF EXISTS fatedrop_products_canonical_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS fatedrop_products_tcg_canonical_key_uidx
  ON fatedrop_products (tcg, canonical_key);

COMMIT;
