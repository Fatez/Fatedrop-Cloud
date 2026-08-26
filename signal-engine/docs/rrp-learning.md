# RRP learning memory

FateDrop treats unresolved UK-English sealed-product RRP/reference misses as intelligence events rather than silently forgetting them.

- `fatedrop_rrp_resolution_queue` stores unresolved observations and recurrence.
- `fatedrop_product_identity_aliases` stores only verified alias-to-canonical mappings.
- Retail sale prices are never promoted into authoritative RRP evidence.
- Ambiguous/import/non-value product classes remain unresolved or reference-only rather than guessed.
