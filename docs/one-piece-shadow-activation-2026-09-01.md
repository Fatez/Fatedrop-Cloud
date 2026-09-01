# One Piece shadow activation checkpoint

Date: 2026-09-01

## Current activation boundary

One Piece is in `catalogue_shadow` only.

- Catalogue ingestion contract: enabled for shadow work.
- Public browse and filters: disabled.
- Production retailer monitoring: disabled.
- Lifecycle alerts: disabled.
- Public notifications: disabled.

The production retailer runtime continues to fail closed for One Piece. The five candidates below exist only in the dedicated observation runner and retain `enabled: false`, `observationOnly: true`, and `catalogue.feedApproved: false`.

## Canonical catalogue gate

The catalogue-readiness contract requires all of the following before a later phase may be proposed:

- a canonical data source with explicit commercial-use approval and a licence reference;
- an independent verification source;
- a fresh snapshot declared complete by its source;
- consistent expected set and card counts;
- exact market, language, set, collector number and printing evidence;
- explicit variant evidence;
- no unresolved, conflicting, stale or rights-rejected records.

Bandai's official [card list](https://en.onepiece-cardgame.com/cardlist/) and [product list](https://en.onepiece-cardgame.com/products/) are verification references. Their published reproduction warning means they must not be copied wholesale into FateDrop without permission. A licensed commercial provider may be used only under a tier and terms that actually cover FateDrop's use; for example, JustTCG documents commercial use separately in its [terms](https://justtcg.com/terms) and [commercial-use guide](https://justtcg.com/docs/commercial-use).

No catalogue source is silently approved by this checkpoint.

## Observation-only retailer candidates

| Retailer | Official collection | Runtime status |
| --- | --- | --- |
| Cob & Pip | `https://cobandpip.co.uk/collections/one-piece-sealed` | Pending qualification |
| LZ Collectibles | `https://lzcollectibles.com/collections/opcg` | Pending qualification |
| Card Goblin | `https://www.cardgoblin.shop/collections/one-piece` | Pending qualification |
| The Card Club UK | `https://thecardclubuk.shop/collections/one-piece-card-game` | Pending qualification |
| Shake Central | `https://shakecentral.co.uk/collections/one-piece` | Pending qualification |

These candidates are not approved feeds and are not part of the production scanner registry. A live shadow observation still has to prove endpoint access, traversal completeness, stable identity and acceptable retailer health.

## Silent baseline operation

Run from `signal-engine` only in an approved observation environment:

```sh
ONE_PIECE_SHADOW_OBSERVATION_ENABLED=true npm run one-piece:shadow > one-piece-shadow-1.json
ONE_PIECE_SHADOW_OBSERVATION_ENABLED=true npm run one-piece:shadow -- --baseline=one-piece-shadow-1.json > one-piece-shadow-2.json
```

The first successful observation for each retailer is silent. Failed and incomplete scans retain the previous retailer baseline. Later exact offer transitions create observation-only episodes; they cannot create Whisper, Echo, Manifested, Vanished, push, Discord or public Web events.

## Promotion order

1. Obtain and declare lawful catalogue data rights.
2. Load and reconcile a complete fresh snapshot until the catalogue gate passes.
3. Run the five retailers through observation-only qualification and establish silent baselines.
4. Review matched, unresolved, conflicting, rejected and stale offer output.
5. Enable internal test-account delivery in a later, separately reviewed checkpoint.
6. Enable public One Piece browse and filters only after the catalogue gate.
7. Enable public notifications last.

TestFlight may carry the fail-closed App capability UI before steps 1–7 complete. TestFlight presence is not evidence that One Piece public monitoring or notifications are active.
