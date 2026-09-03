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
- Collection progress now fails closed when the verified canonical checklist is incomplete, conflicting or has no declared total.
- Added a store-backed collection-progress service.
- Added a read-only catalogue readiness audit and CLI (`npm run collectors:readiness`).
- Added import-source provenance for Collectr/future adapters without making external IDs canonical truth.
- Added a defensive Collectr CSV adapter for common game/set/name/card-number/variant/condition/grade/quantity/cost fields.
- Added deterministic import matching with `exact`, `needs_confirmation`, `ambiguous` and `unresolved` states.
- Added safe re-import reconciliation planning: create/update/unchanged/hold/stale; stale records are never auto-deleted.
- Added an end-to-end Collectr dry-run preview: CSV → validate → canonical match → reconcile plan, with no collection writes.
- Added optional collector purchase-cost storage separated from Fate Price / market truth.
- Added focused test coverage for the new pure/store-backed foundations across Pokémon, One Piece and Lorcana concepts.

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
- The current execution environment could not reach GitHub from the container, so the full Node test suite has NOT been independently executed here.
- Sol/Codespace must run `npm test` before this work is treated as CI-verified.

## Safe next work

1. Run the new and full test suite in Codespace.
2. Fix any integration/syntax failures before adding more features.
3. Run `npm run trader:catalogue` in plan mode and inspect matched/rejected/ambiguous Pokémon sets.
4. Populate the verified Pokémon catalogue using the existing guarded bulk-sync/compiled-artifact path.
5. Re-run `npm run collectors:readiness` until intended Pokémon sets are Collector-ready.
6. Build/complete One Piece canonical catalogue ingestion using its existing evidence contract.
7. Add a Lorcana canonical catalogue adapter/provider with the same fail-closed rules.
8. Only after tests + catalogue readiness, implement transactional Confirm Import writes across collection item + provenance + optional cost basis.
9. Fate Price remains a later dependency for collection £ value and 7D/30D movement, not for owned/missing/completion.

## Locked rules

- Cloud canonical identity remains authoritative.
- External CSV/source IDs are evidence/mappings only, never canonical identity.
- Unknown/incomplete catalogue data fails closed.
- No guessed finish, language or variant identity.
- One shared engine must support Pokémon, One Piece, Lorcana and future TCGs.
- Import preview is non-destructive; stale source rows are review-only.
- Purchase cost never becomes market value.
- No merge or deployment until explicitly approved.
