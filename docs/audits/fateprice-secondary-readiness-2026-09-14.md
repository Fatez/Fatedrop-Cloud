# FatePrice secondary-provider readiness audit — 2026-09-14

This is a **read-only** production audit. It made **no production writes** and **no TCGplayer/eBay network calls**. Production remains on the existing Cardmarket-native pricing path.

## Cohort

- Pricing-eligible English standard/holo identities: 18,538
- Currently Cardmarket-priced: 17,719
- Final unpriced cohort audited: 819
  - Section A — Cardmarket-mapped but unpriced: 94
  - Section B — Cardmarket-unmapped: 725

## Exact TCGplayer crosswalk readiness

The audit used the pinned TCGdex revision `5b6a2859f454972477a9953ffe5cb554d24c45e9`, canonical FateDrop name/collector/finish identity, root and variant-level TCGplayer crosswalk evidence, and fail-closed source-key collision checks.

Initial exact-variant pass across all 819:

- 564 crosswalk-ready, pending approved provider price-lane verification
- 101 held because multiple TCGplayer variant products survived
- 146 held because no TCGplayer product id was present in the pinned evidence
- 8 held because the supplied TCGplayer product+finish source key collided across canonical identities

Section A received one further read-only disambiguation pass. Existing Cardmarket mappings were used **only as evidence to correlate a TCGdex variant carrying both Cardmarket and TCGplayer product IDs**; no Cardmarket mapping was collapsed or changed.

Section A result:

- 78 / 94 crosswalk-ready
- 3 held with multiple TCGplayer variant products
- 13 held with no TCGplayer product id

Section B result from the exact-variant pass:

- 499 / 725 crosswalk-ready
- 85 held with multiple TCGplayer variant products
- 133 held with no TCGplayer product id
- 8 held on TCGplayer source-key collision

Combined best deterministic readiness after the Section A correlation pass:

- **577 / 819 TCGplayer crosswalk-ready (70.45%)**
- **242 / 819 still held (29.55%)**
  - 88 multiple-product ambiguity
  - 146 no TCGplayer product evidence
  - 8 source-key collision

If every one of the 577 crosswalk-ready identities later returns a valid approved TCGplayer price lane, the theoretical coverage ceiling from Tier 2 alone would be 18,296 / 18,538 (98.69%). This is a projection, not an achieved price count.

## Provider-policy gate

Current FateDrop policy marks `tcgplayer-api` as `approval-required`: do not ingest TCGplayer data into Fate Price until FateDrop has explicit provider approval for the intended commercial/aggregation use. There is currently no reviewed/approved eBay sold-pricing provider policy, so the eBay tier remains unreviewed.

Therefore this audit intentionally reports `priceResolved = 0`. Crosswalk readiness must not be represented as live price coverage.

## Next safe activation sequence

1. Establish approved TCGplayer provider access for FateDrop's intended use.
2. Run a **read-only** provider-lane audit for the 577 crosswalk-ready identities, requiring exact finish/subtype and a positive supported market value.
3. Persist only candidates that pass provider-lane, identity ownership, source ownership, and freshness gates.
4. Re-audit the residual queue.
5. Review and approve a lawful eBay/comps provider path before implementing Tier 3; otherwise retain `PRICE_UNAVAILABLE` for residual identities.

Audit workflow run: `34783547389` on branch `audit/fateprice-secondary-readiness-2026-09-14`.
