# Project 2A — Fate Collectors Foundation Progress

Branch: `feat/fate-collectors-project-2a-foundation-2026-09-03`

Status: isolated development only. Do not merge or deploy.

## Completed foundation

- Reused the existing game-agnostic canonical TCG → series → set → printing → exact-card identity model.
- Reused existing user collection ownership rather than creating duplicate collection truth.
- Added deterministic set-completion calculation.
- Added exact missing-card calculation.
- Completion is printing-scoped so language/finish variants do not inflate checklist totals.
- Added canonical set-completeness diagnostics.
- Collection progress fails closed when the verified canonical checklist is incomplete, conflicting or has no declared total.
- Added a store-backed collection-progress service.
- Added a read-only catalogue readiness audit and CLI (`npm run collectors:readiness`).
- Added import-source provenance for Collectr/future adapters without making external IDs canonical truth.
- Added a defensive Collectr CSV adapter.
- Added deterministic import matching with `exact`, `needs_confirmation`, `ambiguous` and `unresolved` states.
- Added safe re-import reconciliation planning: create/update/unchanged/hold/stale; stale records are never auto-deleted.
- Added an end-to-end Collectr dry-run preview: CSV → validate → canonical match → reconcile plan, with no collection writes.
- Purchase-price / collector cost-basis work was removed from V1. Fate Collectors should not require users to enter what they paid.
- Added focused test coverage for the new pure/store-backed foundations across Pokémon, One Piece and Lorcana concepts.

## Product value rule

Fate Collectors should automatically tell the user what a set and their owned cards are worth. The collector should not have to maintain purchase-cost records.

Future valuation should come from one canonical Fate Price / Fate Set Value layer:

- `Full Set Value` = sum of current market values for one canonical checklist printing per set slot.
- `Owned Collection Value` = sum of current market values for the checklist printings the user owns.
- `Missing Card Value` = sum of current market values for the checklist printings they are missing.
- 7D / 30D movement comes from historical market-price snapshots, not user-entered purchase prices.
- If some cards are unpriced, show priced-card coverage and a partial value instead of a fake complete total.
- Currency, source, freshness and confidence must remain explicit.

## Pokémon Wizard research — 2026-09-03

Pokémon Wizard is a useful product/data benchmark for Fate Set Value because it exposes live card prices, total set values and market trend data across hundreds of Pokémon sets.

No public API was identified during the initial review. Its published Terms describe the service as informational/personal-use. Do not scrape or redistribute its pricing data into FateDrop without an authorised API, licence or explicit permission.

Safe uses now:

- benchmark FateDrop set-value calculations against public Pokémon Wizard totals during development;
- study its set/value UX;
- explore authorised commercial/API access if available;
- keep FateDrop's price-provider contract independent so Pokémon, One Piece, Lorcana and future games can use different licensed sources behind one Fate Price interface.

## Production catalogue audit — 2026-09-03

Read-only Neon inspection showed the current production canonical singles catalogue is not ready for Fate Collectors:

- Pokémon: 1 verified set.
- Collector-ready Pokémon sets: 0.
- The only verified set is Darkness Ablaze (`total=201`) with only 1 verified canonical printing and 2 exact identities.
- One Piece: no verified canonical sets currently present in the production singles catalogue.
- Lorcana: no verified canonical sets currently present in the production singles catalogue.

This means the collection/completion engine is ahead of the production catalogue data. Fate Collectors must remain fail-closed until catalogue population is complete enough for each set.

## Existing catalogue machinery discovered

Do not build another Pokémon catalogue provider. The repository already contains:

- TCGdex adapter/client.
- Pokémon TCG API adapter/client.
- Cross-source set reconciliation.
- Verified Pokémon bulk sync.
- Snapshot compiler/loader.
- Existing `trader:catalogue`, `trader:catalogue:compile` and `trader:catalogue:load` commands.

The next catalogue task is therefore to run/verify the existing pipeline and populate complete verified sets, not reinvent ingestion.

One Piece currently has a game-agnostic evidence contract but still requires proven catalogue population/variant evidence before exact card identities can be treated as verified. Lorcana needs its own catalogue source/adapter path before Collectors can expose completion for it.

## Verification state

- New focused test files have been added.
- No GitHub CI/status run is currently attached to this branch checkpoint.
- The current execution environment could not run the full Node suite, so Sol/Codespace must run `npm test` before this work is treated as CI-verified.

## Safe next work

1. Run the new and full test suite in Codespace.
2. Fix any integration/syntax failures before adding more features.
3. Run `npm run trader:catalogue` in plan mode and inspect matched/rejected/ambiguous Pokémon sets.
4. Populate the verified Pokémon catalogue using the existing guarded bulk-sync/compiled-artifact path.
5. Re-run `npm run collectors:readiness` until intended Pokémon sets are Collector-ready.
6. Build/complete One Piece canonical catalogue ingestion using its existing evidence contract.
7. Add a Lorcana canonical catalogue adapter/provider with the same fail-closed rules.
8. Implement transactional Confirm Import writes across collection ownership + import provenance only.
9. Build the canonical Fate Price / Fate Set Value provider layer for automatic collection, set and missing-card valuation.

## Locked rules

- Cloud canonical identity remains authoritative.
- External CSV/source IDs are evidence/mappings only, never canonical identity.
- Unknown/incomplete catalogue data fails closed.
- No guessed finish, language or variant identity.
- One shared engine must support Pokémon, One Piece, Lorcana and future TCGs.
- Import preview is non-destructive; stale source rows are review-only.
- No user-entered purchase price in Fate Collectors V1.
- Market valuation belongs to Fate Price / Fate Set Value and must use real external evidence.
- No merge or deployment until explicitly approved.
