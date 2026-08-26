# FateDrop product discovery watch evidence contract

This is an evidence transport contract, not a lifecycle contract.

External/scheduled discovery watchers may write raw product-page observations to the existing `fatedrop_retailer_discovery_evidence` ledger using `source_type = 'product_discovery_watch'`. The Cloud Signal Engine reconciles pending rows through the canonical product discovery intake and is the only component allowed to decide WHISPER / ECHO / MANIFESTED / VANISHED.

## Producer rules

- Never write a lifecycle state.
- Never infer purchasability from PREORDER / COMING SOON / release-date text.
- Set purchase booleans true only when directly verified.
- Use an exact official retailer product URL when available.
- Use `canonical_pipeline.status = 'pending'` for a materially new evidence fingerprint.
- Rediscovery of an unchanged fingerprint should not reset a processed row to pending.

Example evidence JSON:

```json
{
  "title": "Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)",
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
  "orderable": false,
  "fingerprint": "official-page|not-orderable",
  "canonical_pipeline": { "status": "pending", "attempts": 0 }
}
```

## Upsert rule

The ledger has a unique key on `(retailer_id, source_type, source_url)`. Producers should upsert the row only when the material evidence fingerprint changed. On a changed fingerprint, replace the evidence payload and reset `canonical_pipeline` to `pending`. Unchanged observations should leave the processed row untouched.

The reconciler records the resulting canonical signal IDs/states back into `evidence.canonical_pipeline`. Historical/stale discoveries are still stored, but the canonical discovery intake suppresses stale user-facing alerts.
