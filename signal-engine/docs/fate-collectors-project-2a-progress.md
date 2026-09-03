# Project 2A — Fate Collectors Foundation Progress

Branch: `feat/fate-collectors-project-2a-foundation-2026-09-03`

Status: isolated development only. Do not merge or deploy.

## Completed
- Reused existing game-agnostic canonical TCG → series → set → printing → exact-card identity model.
- Reused existing user collection ownership model rather than creating duplicate collection truth.
- Added deterministic set-completion calculation.
- Added exact missing-card calculation.
- Completion is printing-scoped so language/finish variants do not inflate checklist totals.
- Added fail-closed state when a verified canonical checklist is unavailable.
- Added import-source provenance foundation for future Collectr/import reconciliation.
- Added focused Pokémon, One Piece and Lorcana coverage.

## In progress
- Join catalogue + collection stores behind one collection-progress service.
- Add catalogue-completeness diagnostics so incomplete sets cannot masquerade as complete checklists.
- Prepare deterministic import matching/reconciliation foundation.

## Later dependencies
- Fate Price / historical card valuation for monetary totals and 7D/30D movement.
- App UI.
- FateMatch handoff for missing cards.

## Locked rules
- Cloud canonical identity remains authoritative.
- External CSV/source IDs are evidence/mappings only, never canonical identity.
- Unknown/incomplete catalogue data fails closed.
- One shared engine must support Pokémon, One Piece, Lorcana and future TCGs.
- No merge or deployment until explicitly approved.
