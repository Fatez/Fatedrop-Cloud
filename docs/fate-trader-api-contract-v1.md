# Fate Trader shared API contract v1

## Status
Foundation contract. Routes are not live yet.

## Rules

- API version prefix: `/v1/trader` for Trader resources and `/v1/cards` for canonical card catalogue reads.
- Web and mobile consume the same authoritative contracts.
- IDs returned by the API are opaque. Clients must not derive or construct canonical IDs locally.
- `FATE_TRADE_FOUND` is server-authoritative and can only be returned/emitted after current-state revalidation.
- Unknown identity/value/condition evidence is returned as unknown/unavailable, never guessed.

## Standard success envelope

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "opaque-id",
    "apiVersion": "v1"
  }
}
```

## Standard error envelope

```json
{
  "ok": false,
  "error": {
    "code": "CARD_IDENTITY_NOT_VERIFIED",
    "message": "The requested card identity is not available for trading.",
    "retryable": false,
    "details": {}
  },
  "meta": {
    "requestId": "opaque-id",
    "apiVersion": "v1"
  }
}
```

## Foundation error codes

- `BAD_REQUEST`
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `RATE_LIMITED`
- `CARD_IDENTITY_NOT_VERIFIED`
- `CARD_IDENTITY_CONFLICT`
- `COLLECTION_ITEM_NOT_AVAILABLE`
- `LISTING_STALE`
- `MATCH_NO_LONGER_VALID`
- `TRADE_CONTACT_BLOCKED`
- `VALUE_EVIDENCE_UNAVAILABLE`
- `INTERNAL_ERROR`

## Card catalogue reads

### `GET /v1/cards`
Read-only verified catalogue search/browse.

Clients may filter by TCG, series, set, name, collector number, variant and language. Only `verified` identities are returned to normal clients.

### `GET /v1/cards/:fateCardId`
Returns one verified canonical printed identity and its non-sensitive catalogue attributes.

### `GET /v1/card-sets/:setId/cards`
Returns verified identities for a canonical set.

## Collection

### `GET /v1/trader/me/collection`
### `POST /v1/trader/me/collection/items`
### `PATCH /v1/trader/me/collection/items/:collectionItemId`
### `DELETE /v1/trader/me/collection/items/:collectionItemId`

A collection item references `fateCardId` plus physical-copy state such as condition, grading and photographs. Physical-copy state must never mutate canonical card identity.

## Binder

### `GET /v1/trader/me/binder`
### `POST /v1/trader/me/binder/items`
### `PATCH /v1/trader/me/binder/items/:binderItemId`
### `DELETE /v1/trader/me/binder/items/:binderItemId`

## Wants

### `GET /v1/trader/me/wants`
### `POST /v1/trader/me/wants`
### `PATCH /v1/trader/me/wants/:wantId`
### `DELETE /v1/trader/me/wants/:wantId`

MVP Wants use exact verified `fateCardId` identities plus explicit hard constraints.

## Trade Network

### `GET /v1/trader/network/listings`
Public browse endpoint with privacy-safe filters and pagination.

### `GET /v1/trader/network/listings/:listingId`
Returns one active listing if still public and valid.

## Finder

### `POST /v1/trader/finder/search`
Returns grouped results:

- `exact_reciprocal`
- `compatible_reciprocal`
- `one_way_opportunity`
- `no_match`

Clients must preserve this classification and must not upgrade a result locally.

## Hunts

### `GET /v1/trader/me/hunts`
### `POST /v1/trader/me/hunts`
### `PATCH /v1/trader/me/hunts/:huntId`
### `DELETE /v1/trader/me/hunts/:huntId`

## Matches

### `GET /v1/trader/me/matches`
### `GET /v1/trader/me/matches/:matchId`

Any match detail response includes the authoritative classification, evidence/reasons and `validatedAt` timestamp.

## Feature flags

Initial server/client flags:

- `FATE_TRADER_ENABLED`
- `FATE_TRADER_CATALOGUE_ENABLED`
- `FATE_TRADER_COLLECTION_ENABLED`
- `FATE_TRADER_NETWORK_ENABLED`
- `FATE_TRADER_MATCHING_ENABLED`
- `FATE_TRADER_HUNTS_ENABLED`
- `FATE_TRADER_MESSAGING_ENABLED`

All default false outside explicitly enabled development/private-beta environments until their dependency phase is complete.
