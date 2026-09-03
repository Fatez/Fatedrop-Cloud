# Project 2A — Fate Collectors Foundation Progress

Branch: `feat/fate-collectors-project-2a-foundation-2026-09-03`

Status: isolated development only. Do not merge or deploy.

## Completed foundation

- Reused the existing game-agnostic canonical TCG → series → set → printing → exact-card identity model.
- Reused existing user collection ownership rather than creating duplicate collection truth.
- Added deterministic printing-scoped set completion and exact missing-card output.
- Added catalogue completeness diagnostics; incomplete/conflicting/unknown checklists fail closed.
- Added a store-backed collection-progress service and read-only `npm run collectors:readiness` audit.
- Added Collectr CSV parsing, canonical matching, review states, import provenance, non-destructive reconciliation and full dry-run preview.
- Purchase-price / collector cost-basis work was removed from V1. Users should not have to record what they paid.
- Added Fate Set Value calculation with independent full-set / owned-checklist / missing-card price coverage.
- Added exact-identity collection portfolio valuation so variants and quantity retain financial value even though completion collapses them to one checklist slot.
- Graded cards fail closed for valuation until graded-market evidence exists; raw-card pricing is not reused for slabs.
- Added amount/% movement calculation for 7D/30D history once complete historical valuations exist.
- Added a read-only collector summary orchestrator for collection value, card units, sets owned, closest incomplete set, set completion, missing cards and set-value outputs.
- Added pricing-source permission policy and in-code approval gate.
- Added focused tests for the above; full repository execution remains for Codespace/Sol.

## Correct valuation boundaries

These are intentionally different:

- `Set Completion` = unique canonical printing/checklist slots owned.
- `Full Set Value` = one resolved Fate Price per canonical checklist printing.
- `Owned Checklist Value` = one resolved Fate Price per checklist printing owned; duplicates do not inflate this number.
- `Missing Card Value` = one resolved Fate Price per missing checklist printing.
- `Total Collection Value` = every exact canonical card identity × physical quantity. Variants therefore retain their own value.

No complete monetary total may be shown when required prices are missing. In that case FateDrop exposes `known value + coverage` instead.

Currency is never silently mixed. Historical movement only compares complete valuations in the same currency.

## Pricing-source permission review — 2026-09-03

See `docs/fate-price-source-policy.md` and `src/trader/value/provider-policy.mjs`.

Approved V1 acquisition route:

- **Cardmarket public downloadable product catalogue / price-guide files only.** Cardmarket publicly states these datasets may be imported/incorporated into applications without extra permission and lists Pokémon, One Piece and Lorcana price-guide downloads.

Not approved:

- **Pokémon Wizard:** benchmark/UX reference only; its terms prohibit scraping/systematic extraction and reproduction/redistribution of pricing data without permission.
- **TCGplayer:** approval required for the intended commercial/aggregation use; do not ingest under current terms.
- **Cardmarket authenticated API:** not the approved route; use the separately published public downloads.

The Cardmarket download client now asserts the approved `cardmarket-public-download` policy inside the actual fetch path.

Do not guess One Piece/Lorcana direct artifact IDs from third-party examples. Resolve and verify the official Cardmarket download hrefs in Codespace before enabling those game-specific URLs.

## Production audits — 2026-09-03

### Canonical singles catalogue

Read-only Neon inspection showed:

- Pokémon: 1 verified set, Darkness Ablaze.
- Darkness Ablaze declares `total=201` but has only 1 verified canonical printing and 2 exact identities.
- Collector-ready Pokémon sets: 0.
- One Piece verified canonical sets: 0.
- Lorcana verified canonical sets: 0.

Therefore collection completion must not yet be exposed from production catalogue data.

### Fate Value persistence

The repository already contains `database/fate-value-market-history.sql` plus source-agnostic market observation/persistence code, but the corresponding `fatedrop_market_*` tables are not currently present in production Neon.

Do not deploy this schema from Project 2A. Test/review it separately before any future production application.

## Existing machinery to reuse

Pokémon catalogue population already has:

- TCGdex + Pokémon TCG API clients/adapters;
- cross-source reconciliation;
- verified bulk sync;
- snapshot compilation/loading;
- `trader:catalogue`, `trader:catalogue:compile`, `trader:catalogue:load`.

Fate Value already has:

- Cardmarket public-download transport;
- Cardmarket catalogue/price-guide adapters;
- canonical source mapping resolution;
- source-agnostic market observations;
- transactional market-history persistence code;
- `fate-value-market-history.sql` schema.

Do not create parallel catalogue, collection or pricing truth.

## Verification state

- New focused tests are written.
- No GitHub CI/status run is attached to the current branch checkpoint.
- The current execution environment cannot run the complete repo suite against GitHub, so `npm test` in Codespace is required before this work is treated as verified.

## Safe next work for Sol/Codespace

1. Run `npm test`; fix all failures before extension.
2. Run Pokémon catalogue sync in plan-only mode and review matched/ambiguous/rejected/unmatched sets.
3. Finish/prove complete verified Pokémon catalogue population.
4. Re-run `collectors:readiness` until intended sets are actually ready.
5. Verify official Cardmarket public-download URLs for Pokémon, One Piece and Lorcana; do not scrape HTML.
6. Test the Fate Value market-history migration on a temporary/test database branch only.
7. Wire resolved canonical Fate Price values into the new set/collection summary calculations.
8. Build One Piece canonical catalogue population from its existing evidence contract.
9. Add Lorcana catalogue ingestion with identical fail-closed identity rules.
10. Implement transactional Confirm Import writes across collection ownership + import provenance only.

## Locked rules

- Cloud canonical identity remains authoritative.
- External CSV/source IDs are mappings/evidence only.
- Unknown/incomplete/conflicting data fails closed.
- No guessed finish, language, variant, currency or market price.
- One shared engine supports Pokémon, One Piece, Lorcana and future TCGs.
- No purchase-price admin in Fate Collectors V1.
- No pricing source is allowed merely because its data is publicly visible.
- No merge or deployment until Chris explicitly approves it.
