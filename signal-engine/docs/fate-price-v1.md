# Fate Price v1

## Purpose

Fate Price is the single canonical read-only market valuation service for exact FateDrop card identities. Fate Collectors, Fate Pulse and Fate Trader must consume this service rather than calculate their own card values.

Fate Price never creates or repairs card identity. A card can be priced only from market observations already mapped to an exact verified `fateCardId`.

## v1 calculation policy

Policy version: `fate-price-v1`.

For one exact market scope (`currencyCode` + `marketSegmentKey` + `conditionCode`):

1. Select the latest observation from each independent market source.
2. Current evidence older than 7 days is not eligible.
3. Per source, central-value signals are `marketPrice`, `trendPrice`, `avg7d`, and `avg30d`.
4. A source needs at least two positive central-value signals.
5. The source estimate is the median of its eligible central signals.
6. Fate Price is the median of the eligible source estimates.
7. `lowPrice` and `avg1d` are retained as evidence/context but **never** drive the central Fate Price.
8. The fair range shows disagreement between the stable signals; it is not a promise of executable sale price.

This deliberately prevents the cheapest listing, a one-day spike, or one missing provider field from becoming “the fair price”.

## Market scope

Currency, market segment/finish lane and condition are never silently merged.

If more than one scope is available and the caller has not selected one, Fate Price returns `AMBIGUOUS_MARKET_SCOPE` and lists the available scopes. Unknown stays unknown.

Phase 1 Cardmarket evidence is source-native EUR. Fate Price v1 performs no silent FX conversion. GBP conversion must use separately versioned FX evidence so collection values remain reproducible.

## Movement

7D and 30D movement use historical Fate Price snapshots from the append-only observation ledger. Provider rolling averages are not relabelled as historical movement.

A historical comparison must have a real observation at or before the target date and no more than 3 days older than that target. Otherwise that movement window is unavailable.

## Confidence

Confidence is evidence quality, not prediction confidence.

- `high`: at least two independent market sources, evidence within 48 hours, and central-signal spread at or below 20%.
- `medium`: evidence within 72 hours and spread at or below 30%.
- `low`: usable but older/wider evidence within the hard 7-day eligibility window.

A single provider can therefore reach at most medium confidence in normal fresh conditions.

## API

### Exact card

`GET /v1/fate-price/:fateCardId`

Optional query parameters:

- `currency`
- `marketSegment`
- `condition`

A verified card with no safe market evidence returns HTTP 200 with `available: false` and an explicit reason. An unknown/unverified card identity returns 404.

### Verified card discovery

`GET /v1/fate-price/cards?q=<name-or-collector-number>`

The read may also be constrained with an exact `setId`, `language`, or `variant`. At least two search characters or an exact set identity is required, and at most 100 verified cards are returned. This route belongs to Fate Price and remains available when the Fate Trader catalogue UI is dark; it does not enable the wider Trader API.

`GET /v1/fate-price/cards/:fateCardId` returns one verified canonical card identity.

### Historical points

`GET /v1/fate-price/:fateCardId/history?days=30`

`days` must be `7`, `30`, or `90`. Optional market-scope parameters are the same as the exact-card endpoint. Each point is a Cloud-calculated Fate Price anchored to a market day that has stored exact-card observations. Missing days are not filled, interpolated, or inferred. Ambiguous market scope fails closed until the caller selects one exact scope.

### Batch

`GET /v1/fate-price?ids=<id1>,<id2>,...`

Maximum 100 exact card identities. This is the collection-valuation path and avoids per-card HTTP fan-out.

## Required data path

Fate Price becomes operational only when all of these are true:

1. verified canonical card catalogue exists;
2. exact provider source mappings exist for the relevant card/variant/language;
3. market-history schema is installed;
4. provider snapshots are ingested append-only;
5. observations are fresh enough for the policy;
6. caller consumes the Fate Price contract rather than provider fields directly.

## Explicit non-goals for v1

- price forecasting;
- AI-generated values without market evidence;
- treating lowest listing as fair value;
- mixing standard/holo or languages to increase coverage;
- silent condition normalization;
- silent EUR→GBP conversion;
- graded-card valuation without grade-specific market evidence.
