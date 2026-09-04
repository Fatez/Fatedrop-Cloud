# Fate Collectors — Runtime Valuation Progress

Branch: `feat/fate-collectors-runtime-valuation-2026-09-03`

Status: isolated development only. **Do not merge or deploy without Chris approval.**

## Locked product definition

Fate Collectors shows collectors:

- what they own;
- normal numbered/checklist set completion;
- which checklist cards are missing;
- Known/Fair Price of resolved exact cards;
- collection, set, owned-checklist and missing-card value;
- factual 7D / 30D movement;
- per-game Pokémon / One Piece / Lorcana breakdowns;
- actionable missing-card lists for later FateMatch handoff.

Normal set completion is printing/checklist scoped. Owning any valid exact identity for a canonical printing satisfies that normal completion slot. Exact finish/language/variant still matters for ownership and valuation.

Master Set completion is **not V1**.

## Market stance — locked

**FateDrop reflects the market. FateDrop does not tell users what to do with their money.**

See `docs/fatedrop-market-reflection-policy.md`.

Allowed examples:

- price rising / falling;
- 7D / 30D movement;
- above / below Fair Price;
- near observed historical high / low;
- missing cards are £X cheaper/more expensive than 30 days ago.

Not allowed:

- buy / sell signals;
- good time to buy;
- strong buy;
- investment recommendation;
- expected/predicted price direction or return.

## Consumer pricing contract

### Known Price

Current approved market evidence may be surfaced as `Known Price`.

Consumer price payload is deliberately small:

- `amount`
- `currencyCode`
- `asOf`

Evidence confidence, provider-policy keys and raw source metric selection remain internal eligibility machinery and are not consumer-facing.

If the evidence is insufficient, use `Price unavailable` rather than a weak-confidence badge.

### Fair Price

Fair Price is the future calibrated FateDrop valuation output.

Raw Cardmarket/provider evidence **cannot simply be renamed Fair Price**. `fair-price-policy.mjs` currently keeps `fair-price-v1` in research state with consumer publication disabled.

Collector valuation math is already Fair-Price-ready:

- a calibrated `fair-price` value wins over `raw-market` Known Price for the same exact identity;
- raw-only complete valuation is labelled `Known Value`;
- mixed Fair/Raw valuation is still only `Known Value`;
- `Fair Value` is exposed only when the full required slice is priced by Fair Price;
- partial price coverage exposes known amount + coverage, never a fake complete total.

## Runtime work completed on this branch

- Real approved market evidence is connected into Collector summary valuation.
- Current exact-card Known Prices are resolved from stored market observations + ingest-run provenance.
- 7D / 30D current-holdings-repriced movement is connected.
- Full Set / Owned / Missing value calculations are connected.
- Exact physical collection quantity/variant valuation is separate from printing-scoped completion.
- Missing cards carry simple Known Price and factual 7D / 30D movement.
- Missing cards support number / cheapest / most expensive / price-falling sorting.
- Consumer summary is compact; detailed set route carries the missing-card list.
- Per-TCG collection summaries exist for Pokémon / One Piece / Lorcana/future registered games.
- Collector-specific complete-read helpers detect truncation rather than silently undercounting large sets/collections.
- Collectr CSV Preview and atomic Confirm Import are implemented.
- Re-import refreshes existing source records instead of duplicating mutable condition/quantity changes.
- Stale imported rows are review-only and never auto-deleted.
- Import quantity reduction cannot silently invalidate existing trade intent.
- Purchase price/cost basis is not part of Fate Collectors V1.
- Consumer-facing pricing confidence has been removed.
- Observed-price comparison helper emits only factual above/below reference information.

## Production reality

Latest read-only production audit during this work still showed catalogue/market persistence lagging behind the code:

- production canonical singles catalogue was still the earlier tiny Pokémon state;
- One Piece/Lorcana verified singles catalogue was not yet populated sufficiently for Collectors;
- `fatedrop_market_*` history tables were not present in production at the time of audit.

Therefore the code must remain fail-closed until catalogue population, price mappings and market-history persistence are proven in the target environment.

## Verification boundary

Focused tests have been added/updated for:

- Known Price public contract;
- observational-only market policy;
- Fair Price publication gate;
- Fair-vs-Known valuation priority;
- collection valuation;
- set valuation;
- checklist representative pricing;
- Collector HTTP summary contract;
- historical movement;
- Collectr preview/confirm/reconciliation;
- scale/truncation safety.

Do not call this CI-verified until the complete `signal-engine` test suite is run in Codespace/Sol and any failures are fixed.

## Next execution work

1. Run full `npm test` in Codespace/Sol.
2. Fix all regressions before extending the public contract.
3. Test Collectr Confirm Import against a temporary Postgres/Neon branch.
4. Test `fate-value-market-history.sql` on a temporary database branch.
5. Populate/prove the Pokémon canonical singles catalogue and Cardmarket exact mappings.
6. Begin real daily approved market history ingestion.
7. Backtest/calibrate a Fair Price methodology before changing `fair-price-v1` from research to calibrated.
8. Only then expose Fair Value in consumer environments.
9. Populate/prove One Piece and Lorcana catalogues before activating those games in Collectors.
