# English market completion audit — 12 September 2026

Status: NOT complete. This is a production evidence snapshot, not a full release sign-off.

Cloud baseline: 8ae8588bb481a27ff540ac8d8fe0e18758543781 (PR #478).
App baseline: 0787f21d7d83a950e041c5ec361ebd7ce16ad140.
Production cycle 34701271096 succeeded after #478.

## Production coverage

| Finish | Verified English identities | Cardmarket mapped | Positive price evidence |
|---|---:|---:|---:|
| Standard | 14,144 | 12,463 | 12,458 |
| Holo | 5,428 | 4,831 | 4,396 |
| Reverse holo | 8,153 | 4,450 | 0 |
| Total | 27,725 | 21,744 | 16,954 |

Price evidence means an existing observation where greatest(market_price, trend_price, avg_1d, avg_7d, avg_30d) > 0. It does not prove current freshness or final app eligibility. Raw observation count is not distinct priced-card coverage.

Standard/holo coverage is 16,954 / 19,572 (86.6%). Remaining 2,618: 2,278 unmapped and 440 mapped without positive evidence (5 standard, 435 holo). Reverse holo remains a separate unresolved coverage class; never borrow standard/holo prices.

165 verified sets and 20,023 verified printings are stored. No loaded verified set has fewer verified printings than its stored total. This does not establish absent-set coverage, exact checklist membership, or completeness against null totals.
All verified printings contain artwork.thumbnailUrl. Network/image rendering was not tested.

## Market history and scheduling

43,509 observation rows span 4–12 September, with eight distinct market days. A complete 30-day history has not been established. Per-card history coverage still needs reconciliation.
Daily workflow is configured at 03:20 UTC. Configuration alone does not prove successful scheduled persistence.
Manual and daily production cycles previously used different concurrency groups. This PR aligns their group while preserving cancel-in-progress: false. It does not alter matching or price logic.

## App inspection

Source inspection confirms binder missing-card links to FatePrice, exact-card buy routing, unresolved identity blocking, and disclosure when only known missing-card prices are available.
Insights source has riser/faller navigation and unavailable-history disclosure.
These are source observations, not authenticated device acceptance tests.
Scanner PR Fatez/FateDrop-App#230 remains open/draft; scanning is not present in the inspected main tree.

## Remaining acceptance gates

1. Reconcile all English source sets and exact checklist members against production, explicitly separating edition/finish quarantines. The completion runner's pinned source differs from newer mapping audits; do not silently change that pin.
2. Resolve the 2,278 unmapped standard/holo identities by evidence class; acquire valid observations for the 440 mapped identities lacking positive evidence. Report provider-unavailable data separately.
3. Resolve reverse-holo evidence independently. Keep unknown prices unavailable and preserve all eight first-edition quarantines: base2, base3, base5, gym1, neo1, neo2, neo3, neo4.
4. Verify successful scheduled persistence, distinct daily coverage per identity, retry recovery and freshness. Never fabricate missing history.
5. Test an authenticated app build: era/year binder navigation, image loading, add/remove collection, missing-card purchase links, valuation coverage, FatePrice history and Insights.
6. Review and validate the scanner draft independently before release; require confirmation of the exact card/finish and handle ambiguous scans without automatic false matches.

Completion requires an evidence-backed inventory denominator and explicit accounting for every missing price. No arbitrary 50k/74k target substitutes for this audit. No production changes were made by this audit.
