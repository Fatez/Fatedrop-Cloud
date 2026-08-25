# Fate Trader feature flags v1

Fate Trader must remain dark by default until each dependency is complete and verified.

## Flags

- `FATE_TRADER_ENABLED` — master kill switch. If false, all Trader routes/events are unavailable.
- `FATE_TRADER_CATALOGUE_ENABLED` — verified card catalogue read surfaces.
- `FATE_TRADER_COLLECTION_ENABLED` — personal Collection/Owned/Trade/Wanted state.
- `FATE_TRADER_NETWORK_ENABLED` — public Trade Network browse/listings.
- `FATE_TRADER_MATCHING_ENABLED` — Fate Trade Finder and match creation.
- `FATE_TRADER_HUNTS_ENABLED` — persistent Fate Trade Hunt evaluation/notifications.
- `FATE_TRADER_MESSAGING_ENABLED` — Trader-linked conversations/contact.

## Dependency rules

`FATE_TRADER_ENABLED` must be true for every subordinate flag.

`FATE_TRADER_COLLECTION_ENABLED` requires `FATE_TRADER_CATALOGUE_ENABLED`.

`FATE_TRADER_NETWORK_ENABLED` requires `FATE_TRADER_COLLECTION_ENABLED`.

`FATE_TRADER_MATCHING_ENABLED` requires both Collection and Network.

`FATE_TRADER_HUNTS_ENABLED` requires Matching.

`FATE_TRADER_MESSAGING_ENABLED` requires Network and trust/report/block controls to be available.

## Defaults

All flags default to false in production until explicitly enabled through deployment configuration.

The website and app may hide navigation when disabled, but backend enforcement remains authoritative; a client-side flag is never a security boundary.

## Rollback

The master flag must provide an immediate Trader-wide disable path without affecting FateDrop Search, FateFind, FateMatch, alerts or existing signal-engine functions.
