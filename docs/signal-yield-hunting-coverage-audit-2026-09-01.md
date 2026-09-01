# Signal Yield + Hunting Coverage Audit — 2026-09-01

Status: review checkpoint only. No merge or deployment has been performed.

Governing rule: **Discovery aggressive. Manifested strict.** Discovery failures must never be converted into stock claims, and incomplete scans must never manufacture Vanished events.

## Production snapshot

This is a read-only rolling 24-hour production snapshot captured on 2026-09-01 UTC. Candidate qualification dry-runs are excluded from the live funnel.

The delivery boundary is healthy in this window. Nine accepted Manifested events were observed across JET Cards (3), TGC Collectables (4), Total Cards (1), and Card Collective UK (1); all nine reached provider acceptance. There were no retryable, outcome-unknown, or dead-letter delivery rows. Two Total Cards Whisper events were intentionally inbox-only and are not lost Manifested alarms.

The main losses occur before candidate acceptance:

1. fourteen monitored retailers have blocked, empty, or stale coverage;
2. JET Cards reaches its six-page structured-feed limit on every telemetry-equipped run and is marked partial despite observing more than 600 accepted offers per scan;
3. the live yield report previously mixed observation-only candidate qualification runs into production scan totals;
4. candidate-stage decisions, canonical deduplication, and detailed policy suppression reasons were not persisted per run;
5. a verified sealed multi-pack format was classified as unknown, hiding genuine availability transitions;
6. John Lewis was polling a retired category URL that returns 404;
7. Pokémon Center UK remains truthfully stale because its separate browser collector has not refreshed the production catalogue. Cloud must continue to fail closed until that collector runs again.

## Ranked coverage recovery queue

| Rank | Retailer | 24h scans | Offers | Primary loss | Checkpoint disposition |
|---:|---|---:|---:|---|---|
| 1 | John Lewis & Partners | 62 failed | 0 | retired category URL (404) | coded: monitored-only runtime override uses the current official Pokémon Card Games category |
| 2 | JET Cards | 28 partial | 17,081 | page cap reached on every telemetry run | coded: structured traversal raised from 6 to 12 pages |
| 3 | Evo Cards | 21 failed | 0 | category cards yield zero qualifying products | unresolved: official collection exists; adapter/platform change still needs exact feed qualification |
| 4 | Smyths Toys UK | 21 failed | 0 | category traversal yields zero qualifying products | unresolved: retain fail-closed state; endpoint/extractor qualification required |
| 5 | The Card Vault | 21 failed | 0 | category cards yield zero qualifying products | unresolved: official collection exists; adapter/platform change still needs exact feed qualification |
| 6 | Argos | 4 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 7 | Tesco | 4 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 8 | The Entertainer | 4 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 9 | Very | 4 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 10 | ASDA | 3 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 11 | Chaos Cards | 3 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 12 | Hamleys UK | 3 failed | 0 | retailer access block (403) | access-control hold; no bypass |
| 13 | GAME UK | 0 | 0 | stale after request timeout | unresolved: endpoint/adapter recovery required |
| 14 | Pokémon Center UK | external | 0 Cloud scans | browser collector stale | operational recovery on the interactive collector host; Cloud remains fail-closed |

The John Lewis replacement is grounded in the retailer's current official [Pokémon Card Games category](https://www.johnlewis.com/browse/baby-child/games-puzzles/view-all-games-puzzles/pok%C3%A9mon/card-games/_/N-6hxeZ1z079nuZ1yze6yu) and its current product URL shape. Evo Cards and The Card Vault have current official sealed-product collections, but this checkpoint deliberately does not guess that an unverified JSON/feed route is production-safe.

## Productive retailer funnel

`W/E/M` means accepted Whisper / Echo / Manifested rows. Echo readiness events are separate from ordinary catalogue classification.

| Retailer | Scans | Offers seen | Changes | W/E/M | Emitted | Suppressed | Canonical conflicts |
|---|---:|---:|---:|---:|---:|---:|---:|
| Gathering Games | 124 | 52,644 | 1 | 1 / 0 / 0 | 1 | 0 | 0 |
| TGC Collectables | 122 | 5,131 | 8 | 0 / 0 / 4 | 4 | 0 | 1 |
| Total Cards | 53 | 124,020 | 4 | 2 / 0 / 1 | 1 | 2 | 1 |
| Card Collective UK | 125 | 70,123 | 26 | 0 / 0 / 1 | 1 | 0 | 1 |
| Double Sleeved | 125 | 55,000 | 2 | 0 / 0 / 0 | 0 | 0 | 1 |
| Eterna Cards | 123 | 54,243 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| Titan Cards | 111 | 51,171 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| Travelling Man UK | 114 | 46,170 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| Magic Madhouse | 118 | 37,223 | 2 | 0 / 0 / 0 | 0 | 0 | 2 |
| Zatu Games | 103 | 18,437 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| Shake Central | 123 | 6,150 | 1 | 0 / 0 / 0 | 0 | 0 | 1 |
| FolioTCG | 125 | 5,250 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| LZ Collectibles | 124 | 5,084 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| The TCG Shop | 123 | 2,829 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| Phantom Cards UK | 123 | 2,706 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| GY Gaming & Collectibles | 125 | 2,125 | 1 | 0 / 0 / 0 | 0 | 0 | 0 |
| The Card Club UK | 123 | 1,476 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |
| Cora Cards | 126 | 630 | 0 | 0 / 0 / 0 | 0 | 0 | 0 |

Transient upstream 503s account for the single failed Gathering Games and TGC Collectables scans; both retailers recovered and are currently healthy.

## Code changes at this checkpoint

- Persist an exact `signalFunnel` diagnostic with offers processed, changed observations, candidates by lifecycle, accepted/conflicted/deduplicated canonical outcomes, delivery policies, and detailed policy reasons.
- Keep historical fallback explicit: candidate totals remain labelled lower bounds until every product-bearing run in the selected window has candidate-stage telemetry.
- Add scan cadence, expected-window coverage, in-progress run counts, page-limit counts, and a deterministic recovery ranking to the yield report.
- Exclude `qualification_dry_run` rows from the production funnel.
- Recover sealed numeric/worded multi-pack bundles while preserving merchandise exclusions.
- Expand JET Cards to a complete bounded traversal of up to 12 structured pages.
- Override John Lewis only when its canonical registry row is already monitored; the override cannot promote a candidate or mutate registry state.

## Intentionally not changed

- Manifested purchase truth, confidence thresholds, baseline silence, canonical episode semantics, and delivery eligibility.
- Access-blocked retailers. FateDrop does not bypass retailer controls.
- Pokémon Center collector health. Stale collector evidence stays stale.
- Evo Cards, Smyths, and The Card Vault adapters. Exact replacement feeds or extractors need qualification before activation.
- One Piece catalogue or monitoring work. It remains parked behind this review checkpoint.

## Verification at checkpoint

- Signal Engine: 1,051 tests passed, 0 failed.
- Pokémon Center browser collector: 19 tests passed, 0 failed.
- Signal Engine and collector production dependency audits: 0 vulnerabilities.
- Git whitespace/error check: clean.
- The PostgreSQL schema/persistence smoke rehearsal was not available locally because this workspace has no PostgreSQL service or isolated test connection. No database schema or persistence implementation changed in this tranche; the smoke rehearsal remains a required CI check before merge.
