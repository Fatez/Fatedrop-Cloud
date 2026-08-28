# FateDrop product discovery watch evidence contract

This is an evidence transport contract, not a lifecycle contract.

The scheduled Pokémon UK Drop Watch is an external evidence producer. Its durable transport is a GitHub issue in `Fatez/Fatedrop-Cloud` whose title starts `[FATEDROP DISCOVERY WATCH] ` and whose body is pure JSON. Cloud polls those issue records, validates them, and imports valid observations into the existing `fatedrop_retailer_discovery_evidence` ledger with `source_type = 'product_discovery_watch'`.

The existing Cloud discovery reconciler then consumes pending ledger rows through the canonical product discovery intake. The Cloud Signal Engine remains the only component allowed to decide WHISPER / ECHO / MANIFESTED / VANISHED.

## Producer rules

- Never write or request a lifecycle state.
- Never include `state` or `lifecycle` anywhere in the transport payload.
- Never infer purchasability from PREORDER / COMING SOON / release-date text.
- Set purchase booleans true only when directly verified.
- Use an exact `https://www.pokemoncenter.com/en-gb/product/...` URL.
- Set `retailerId` to `pokemon-center-uk` and mark each observation with `discoveryObservation: true`.
- Create an issue only for a materially new evidence fingerprint. Unchanged rediscovery should not create another transport record.

Example issue body:

```json
{
  "retailerId": "pokemon-center-uk",
  "observations": [{
    "discoveryObservation": true,
    "title": "Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)",
    "canonicalUrl": "https://www.pokemoncenter.com/en-gb/product/example",
    "pageExists": true,
    "officialPageVerified": true,
    "evidenceSource": "pokemon_uk_drop_watch",
    "changeType": "new_official_product_page",
    "confidence": 0.98,
    "preorderText": false,
    "addToCartEnabled": false,
    "preorderPurchaseEnabled": false,
    "checkoutVerified": false,
    "availabilityApiVerified": false,
    "orderable": false
  }]
}
```

## Cloud transport rules

- GitHub issue creation time is the canonical observation time for this transport. A delayed or historical issue therefore stays historical and cannot be made fresh merely by retrying it.
- Cloud accepts only the FateDrop repository issue prefix, Pokémon Center UK retailer identity, and canonical Pokémon Center UK product URLs.
- Any payload containing `state` or `lifecycle` is rejected before it reaches discovery normalization.
- Issue observations are whitelisted into the evidence contract; arbitrary JSON fields are not promoted into canonical evidence.
- Cloud polls no more than once every five minutes per running instance and a failed GitHub poll never blocks already-persisted discovery evidence from reconciling.
- The existing PostgreSQL advisory lock still prevents two Cloud reconciliation cycles from consuming the same ledger work concurrently.

## Ledger upsert rule

The ledger unique key remains `(retailer_id, source_type, source_url)`. GitHub imports use a stable material-evidence fingerprint. An unchanged fingerprint never resets a processed row. Changed evidence may replace the row only when its GitHub observation time is at least as new as the stored evidence, and the canonical pipeline is then reset to `pending`.

The reconciler records resulting canonical signal IDs/states back into `evidence.canonical_pipeline`. Historical/stale discoveries are still stored as evidence, but the existing canonical discovery freshness rules suppress stale user-facing alerts.

## Lifecycle safety boundary

This transport does not modify signal qualification, previous-state semantics, prior-live proof, or lifecycle delivery. In particular, Vanished remains governed by the existing canonical prior-live rules. The GitHub bridge may only deliver raw evidence into the pre-existing discovery intake; it cannot declare or force any lifecycle state.
