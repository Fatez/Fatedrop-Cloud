-- Exact single-card retail crosswalk for FatePrice "Where to buy".
-- Retail offers remain separate from market-value observations. Only explicitly
-- verified mappings may be published or compared with FatePrice.

CREATE TABLE IF NOT EXISTS fatedrop_card_retail_offer_mappings (
  id TEXT PRIMARY KEY,
  card_identity_id TEXT NOT NULL REFERENCES fatedrop_card_identities(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL REFERENCES fatedrop_retail_offers(offer_id) ON DELETE CASCADE,
  market_segment_key TEXT,
  condition_code TEXT,
  language_code TEXT,
  verification_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (verification_status IN ('staged', 'verified', 'conflict', 'quarantined', 'retired')),
  verified_at BIGINT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (card_identity_id, offer_id)
);

CREATE INDEX IF NOT EXISTS fatedrop_card_retail_offer_card_idx
  ON fatedrop_card_retail_offer_mappings(card_identity_id, verification_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS fatedrop_card_retail_offer_offer_idx
  ON fatedrop_card_retail_offer_mappings(offer_id);
