# Market Pulse — Phase 1A

## Purpose

Market Pulse Phase 1A is the source-agnostic evidence aggregation layer that sits downstream of Fate Value market observations and upstream of future Market Pulse scoring, ranking and UI.

Phase 1A deliberately does **not** decide whether a card, set or TCG is hot, cold, volatile, surging or falling. It only turns immutable canonical market observations into transparent movement and coverage facts that a later policy layer can score.

The governing flow is:

`raw provider evidence -> canonical market observations -> Market Pulse 1A aggregates -> future Pulse policy/scoring -> API/UI`

## Canonical identity

Market Pulse does not create or repair identity.

- `cardIdentityId` must resolve to an existing canonical FateDrop card identity.
- Game and set grouping come from that canonical identity's `tcgCode` and `setCode`.
- Unresolved identities are excluded from calculations and counted as an evidence gap.
- Market evidence cannot invent a TCG, set, card, printing, variant or language.
- The aggregation model is TCG-agnostic. Pokémon, One Piece, Lorcana and future games use the same contract.

## Explicit market basis

Every snapshot requires an explicit comparison basis:

- `sourceName`
- `priceField`
- `currencyCode`
- `marketSegmentKey`
- `conditionCode`

Supported standard price fields are inherited from the Fate Value observation contract:

- `marketPrice`
- `lowPrice`
- `trendPrice`
- `avg1d`
- `avg7d`
- `avg30d`
- `avgLifetime`
- `excellentPlusLow`

Phase 1A never silently substitutes another price field. If `trendPrice` is selected and only `marketPrice` exists, that lane has no usable current `trendPrice` evidence.

Phase 1A also never mixes currencies, sources, market segments or conditions inside one snapshot. Cross-source or FX-normalised market policy belongs to a later explicitly versioned layer.

## Market day and comparison windows

One snapshot has one global `anchorMarketDay`: the latest market day in matching mapped evidence.

A lane contributes a current value only when it has the selected price field on that exact anchor day. Lanes whose newest usable observation is older are counted as stale rather than mixed into a newer market snapshot.

Phase 1A comparison windows are exact UTC market-day offsets:

- `d1` = anchor day minus 1 calendar day
- `d7` = anchor day minus 7 calendar days
- `d30` = anchor day minus 30 calendar days

If an exact baseline day is absent, the movement for that window is unknown. Phase 1A does not substitute a nearby trading day or carry a price forward. A future policy may add a separately specified baseline-selection rule after it has been backtested.

## Lane definition

Within the already selected source/currency/segment/condition basis, a comparison lane is:

`cardIdentityId + sourceVariantKey`

The latest observation on a required market day wins only within that exact lane/day. Variant lanes are never merged implicitly.

## Movement contract

For each current lane and each available baseline:

- absolute movement = `currentPrice - baselinePrice`
- percentage movement = `(currentPrice - baselinePrice) / baselinePrice * 100`

A zero baseline preserves absolute movement but percentage movement remains `null` because the percentage is undefined.

No missing result is converted to zero.

## Aggregate facts

Phase 1A aggregates current lanes at market, TCG and set level.

For each 1D / 7D / 30D window it exposes:

- eligible current lanes
- contributors with a valid baseline
- contributors with a valid percentage
- baseline coverage percentage
- mean absolute movement
- median absolute movement
- mean percentage movement
- median percentage movement
- rising lane count
- falling lane count
- flat lane count

Coverage is evidence, not confidence. Phase 1A intentionally does not manufacture a confidence score from incomplete data.

## Snapshot contract

The pure `buildMarketPulseSnapshot` function returns:

- `schemaVersion: market-pulse:1a`
- generation timestamp
- global anchor market day
- explicit market basis
- optional TCG/set scope
- evidence counts and stale/unresolved gaps
- market-level movement aggregates
- per-TCG movement aggregates
- per-set movement aggregates
- per-card/source-variant movement facts

An empty evidence set returns the same stable contract with empty arrays and unknown coverage where no denominator exists.

## Explicitly out of scope for Phase 1A

- Market Heat score
- volatility score/index
- heating-up / cooling-down rankings
- biggest mover ranking policy
- unusual-movement or anomaly detection
- popularity, watchlist or demand signals
- source weighting or source blending
- FX conversion
- outlier suppression
- liquidity weighting
- price forecasting
- Fate Fair Value
- public API exposure
- App/Web UI exposure
- database schema changes or writes
- production deployment

Those are intentionally reserved for Market Pulse Phase 1B and later layers so scoring policy can change without corrupting the underlying evidence contract.

## Phase 1A exit gate

Phase 1A is ready to hand to the scoring layer when:

1. exact 1D / 7D / 30D movement is deterministic;
2. missing baselines remain unknown;
3. source/currency/segment/condition boundaries cannot cross implicitly;
4. one global market anchor prevents stale/current dates being mixed;
5. unresolved canonical identities are excluded and counted;
6. Pokémon and One Piece evidence aggregate through the same TCG-agnostic path;
7. zero baselines do not create fake percentage movement;
8. empty evidence produces a stable empty contract;
9. no score, heat label or confidence value is invented;
10. no database, API, UI or production behaviour changes.

## Phase 1B handoff

Phase 1B may build on these facts to implement a versioned Market Pulse policy for volatility, heat, heating/cooling, movers and unusual activity. That layer should retain the raw coverage and provenance exposed here so every public score remains explainable and can be backtested or replaced without rewriting market history.
