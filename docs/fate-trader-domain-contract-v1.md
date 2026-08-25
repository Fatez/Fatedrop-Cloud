# Fate Trader Domain Contract v1

## Core identifiers

Use stable opaque IDs for authoritative entities:

- fate_card_id
- collection_item_id
- binder_item_id
- want_id
- trade_listing_id
- trade_match_id
- trade_hunt_id
- conversation_id

External catalogue/provider IDs are mappings only and must never become FateDrop primary identity.

## Card identity

A canonical card identity represents a verified printed card/variant/language combination.

Minimum fields:

- fate_card_id
- tcg_id
- series_id
- set_id
- printing_id
- card_number
- variant_id
- language_id
- verification_state
- created_at
- updated_at

Verification states:

- STAGED
- VERIFIED
- CONFLICT
- QUARANTINED
- RETIRED

Only VERIFIED may receive new collection/trade references.

## Collection item

Represents a user's physical copy or homogeneous quantity of copies.

Minimum fields:

- collection_item_id
- user_id
- fate_card_id
- quantity
- raw_or_graded
- declared_condition
- grader
- grade
- certification_number
- visibility
- created_at
- updated_at

Grade-related fields are nullable and valid only when raw_or_graded = GRADED.

## Trade Binder item

Represents explicit availability to trade.

Minimum fields:

- binder_item_id
- user_id
- collection_item_id
- quantity_available
- status
- trade_mode
- local_trade_allowed
- postal_trade_allowed
- notes
- created_at
- updated_at

Statuses:

- AVAILABLE
- IN_NEGOTIATION
- RESERVED
- TRADED
- WITHDRAWN

Initial trade modes:

- OPEN
- EXACT_WANTS_ONLY
- POOL
- EXACT_BUNDLE

## Want

Represents explicit demand.

Exact-card MVP fields:

- want_id
- user_id
- fate_card_id
- quantity
- minimum_condition
- raw_or_graded_preference
- minimum_grade
- maximum_grade
- local_allowed
- postal_allowed
- priority
- status
- created_at
- updated_at

Statuses:

- ACTIVE
- PAUSED
- SATISFIED
- CANCELLED

Criteria-based wants are later-phase extensions and must resolve through structured verified catalogue attributes.

## Trade Listing

Represents explicit published trade intent.

Minimum fields:

- trade_listing_id
- user_id
- status
- visibility
- bundle_semantics
- local_allowed
- postal_allowed
- created_at
- updated_at

Child records:

- trade_listing_offer_items
- trade_listing_want_items

Initial bundle semantics:

- POOL
- EXACT_BUNDLE

## Trade Match

A match is derived state, never manually asserted by a client.

Minimum fields:

- trade_match_id
- user_a_id
- user_b_id
- classification
- fingerprint
- evidence_version
- status
- created_at
- last_verified_at

Classifications:

- EXACT_RECIPROCAL
- COMPATIBLE_RECIPROCAL
- ONE_WAY_OPPORTUNITY

Statuses:

- ACTIVE
- STALE
- CONTACTED
- DECLINED
- COMPLETED
- INVALIDATED

Before notification or display as FATE TRADE FOUND, the service must revalidate current authoritative state.

## Match fingerprint

A deterministic fingerprint must represent the material matching state so unchanged matches do not create duplicate alerts.

Inputs should include at minimum:

- sorted user IDs;
- relevant canonical card IDs;
- relevant binder item/version state;
- relevant want/listing version state;
- hard matching constraints.

## Fate Trade Hunt

Minimum fields:

- trade_hunt_id
- user_id
- target specification
- offered item references or offer policy
- constraints
- status
- last_evaluated_at
- last_match_at
- notification policy
- created_at
- updated_at

Statuses:

- ACTIVE
- PAUSED
- MATCHED
- EXPIRED
- CANCELLED

## Value evidence boundary

Market evidence is separate from matching truth.

A trade may match without having a reference value.

If value evidence is insufficient or incompatible, return REFERENCE_VALUE_UNAVAILABLE rather than inventing a number.

Never persist or expose subjective labels such as GOOD_TRADE, BAD_TRADE or FAIR_TRADE.

## Privacy boundary

Public trading data must exclude private contact details and exact live location.

Location matching should use coarse region/radius abstractions. Messaging should default to in-product communication.

## API responsibility split

Authoritative server APIs should eventually provide:

- catalogue navigation/search;
- collection state;
- binder state;
- wants;
- listings;
- Trade Network queries;
- Fate Trade Finder queries;
- match detail/revalidation;
- Hunt CRUD;
- notifications/events;
- block/report state.

Web and mobile clients must consume the same contracts and must not independently infer exact match classifications.
