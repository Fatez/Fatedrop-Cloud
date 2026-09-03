# Fate Collectors — Project 2A Sol Handoff

## Branch

`feat/fate-collectors-project-2a-foundation-2026-09-03`

Do not merge or deploy unless Chris explicitly approves it.

## Goal

Finish and verify the reusable Fate Collectors backend foundation for Pokémon, One Piece, Lorcana and future TCGs without duplicating canonical identity or pricing truth.

## What is already implemented on this branch

- Printing-scoped set completion.
- Exact missing-card output.
- Fail-closed catalogue completeness checks.
- Store-backed set-progress service.
- Per-TCG catalogue readiness audit.
- `npm run collectors:readiness` read-only CLI.
- Collectr CSV parser/normalizer.
- Canonical import matcher with exact / confirmation / ambiguous / unresolved states.
- Import-source provenance.
- Non-destructive re-import reconciliation planner.
- End-to-end Collectr import preview/dry-run with no writes.
- Optional purchase-cost persistence isolated from market value.
- Focused tests for all of the above.

## Production audit result at handoff

Read-only Neon inspection on 3 September 2026 showed:

- Only Pokémon exists in the verified singles catalogue.
- Only one verified Pokémon set exists: Darkness Ablaze.
- Darkness Ablaze declares `total=201`, but only 1 verified canonical printing and 2 exact card identities are present.
- Therefore 0 production sets are currently Collector-ready.
- No verified One Piece or Lorcana canonical sets are currently present.

Do not expose collection completion from this production catalogue yet.

## Important discovery

Pokémon catalogue population infrastructure already exists. Do NOT create another provider.

Existing path includes:

- TCGdex client/adapter.
- Pokémon TCG API client/adapter.
- Cross-source reconciliation.
- Verified bulk sync.
- Snapshot compilation/loading.
- Commands:
  - `npm run trader:catalogue`
  - `npm run trader:catalogue:compile`
  - `npm run trader:catalogue:load`

The sync CLI is plan-only unless `--write` is explicitly supplied, and writes are additionally guarded by `FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true`.

## First actions

From `signal-engine` on this branch:

1. Run `npm test`.
2. Fix all failures before extending scope.
3. Run `npm run trader:catalogue` with no `--write` and save/review the plan output.
4. Review matched, ambiguous, rejected, source-error and unmatched set groups.
5. Prove a complete verified Pokémon catalogue can be compiled/loaded or synced through the existing path.
6. Re-run `npm run collectors:readiness -- --tcg=pokemon`.
7. A set may be exposed to Fate Collectors only when readiness says its verified printing count exactly matches its declared canonical total.

## Import write work still required

Do not directly wire the preview plan to separate create/update/source/cost calls without considering atomicity.

Implement a transactional Confirm Import path so each confirmed row applies collection ownership + provenance + optional cost basis consistently.

Rules:

- Only `exact` matches may auto-apply.
- `needs_confirmation`, `ambiguous` and `unresolved` remain user-review states.
- Never auto-delete stale rows from a refreshed CSV.
- Re-import of the same source record must update rather than duplicate.
- Graded quantity >1 must be split into individual physical collection items or explicitly confirmed through a safe flow.
- Do not guess missing currency, price scope, variant, finish or language.
- Purchase price is collector cost basis only; Fate Price owns market valuation.

## Catalogue expansion

### Pokémon

Use the existing verified cross-source catalogue pipeline. Finish population and readiness proof.

### One Piece

Reuse `one-piece-contract.mjs`. It intentionally refuses to invent variant evidence. Complete the canonical catalogue ingestion path and only verify exact identities where finish/parallel/language evidence is sufficient.

### Lorcana

Add a catalogue adapter/provider following the same canonical evidence and fail-closed rules. Do not add Lorcana-specific ownership tables.

## Fate Price boundary

Do not block owned/missing/completion work on Fate Price.

Fate Price is required later for:

- total collection market value;
- set value;
- missing-card value;
- 7D/30D value movement;
- cost-vs-market comparison.

Collectors should consume one canonical Fate Price service when it exists rather than adding separate valuation logic.

## Verification before any merge proposal

- `npm test` green.
- Existing catalogue tests green.
- New Fate Collectors tests green.
- Database migrations reviewed on a temporary/test branch first.
- Pokémon catalogue readiness report reviewed.
- Import preview tested with representative Collectr files including duplicates, ambiguous variants, graded cards, missing numbers and repeat imports.
- No main merge.
- No production deployment.

## Current product principle

Less work for the collector:

`Import collection → FateDrop identifies owned cards → calculates set completion → shows only missing cards → later FateMatch finds them.`

The user should never have to scroll a 1–200 image checklist just to discover what is missing.
