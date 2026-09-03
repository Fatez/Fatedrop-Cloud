# Fate Collectors — Project 2A Sol Handoff

## Branch

`feat/fate-collectors-project-2a-foundation-2026-09-03`

**Do not merge or deploy unless Chris explicitly approves it.**

## Goal

Finish and verify a reusable Fate Collectors backend for Pokémon, One Piece, Lorcana and future TCGs without duplicating canonical identity, collection ownership or pricing truth.

## Foundation already implemented

### Collection / completion

- Printing-scoped set completion.
- Exact missing-card output.
- Preferred representative selection for display/checklist valuation.
- Fail-closed canonical catalogue completeness checks.
- Store-backed set-progress service.
- Per-TCG catalogue readiness audit.
- Read-only `npm run collectors:readiness` CLI.
- Read-only collector summary orchestration for collection value, card units, sets owned, closest incomplete set, missing cards and set values.

### Collectr import groundwork

- Defensive CSV parser/normalizer.
- Canonical matcher with `exact`, `needs_confirmation`, `ambiguous`, `unresolved` states.
- Import-source provenance.
- Non-destructive reconciliation planner (`create`, `update`, `unchanged`, `hold`, `stale`).
- End-to-end preview/dry-run with no collection writes.
- Repeat imports are designed to reconcile rather than duplicate.
- Stale source rows are never auto-deleted.

Purchase-price / cost-basis persistence was deliberately removed from V1. Users should not have to record what they paid.

### Fate Price / valuation groundwork

Existing source-agnostic market observation/persistence infrastructure was reused rather than replaced.

Added:

- provider permission registry (`value/provider-policy.mjs`);
- source-governance documentation (`docs/fate-price-source-policy.md`);
- Cardmarket fetch-path policy enforcement;
- multi-TCG Cardmarket snapshot/batch provenance;
- deterministic Fate Price resolver (`value/fate-price.mjs`);
- checklist representative → printing price mapper (`value/checklist-prices.mjs`);
- coverage-safe Fate Set Value (`value/set-value.mjs`);
- exact-identity × quantity collection valuation (`value/collection-value.mjs`);
- 7D/30D amount/% movement calculator (`value/value-movement.mjs`);
- focused tests for each of the above.

## Locked valuation semantics

These are intentionally different:

- **Set Completion** = unique canonical printing/checklist slots owned.
- **Full Set Value** = one resolved Fate Price per canonical checklist printing.
- **Owned Checklist Value** = one resolved price per checklist printing owned; duplicate copies do not inflate this number.
- **Missing Card Value** = one resolved price per missing checklist printing.
- **Total Collection Value** = every exact canonical card identity × physical quantity; variants retain their own financial value.

No required price = no fake complete total. Return known value + coverage instead.

Graded cards are not valued with raw-card evidence.

Language and finish are not inferred from market/location. Checklist valuation requires an explicit preferred language and variant. If that representative is unpriced, coverage drops rather than substituting another language/finish.

Currency is never silently mixed or converted.

## Fate Price V1 definition

For one exact card identity, consider only:

- matching card identity;
- explicitly requested currency;
- current/non-stale evidence;
- evidence whose `providerPolicyKey` resolves to an approved acquisition route.

Select the freshest eligible observation first. Within that observation use this metric order:

1. `marketPrice`
2. `trendPrice`
3. `avg7d`
4. `avg30d`

**Do not use `lowPrice` as the default Fate Price.** A cheap live listing is not the same thing as market value.

The resolver returns amount, metric used, currency, source, policy key, freshness and deterministic confidence. It performs no FX conversion.

Persisted market observations must be enriched with `providerPolicyKey` from their ingest run before entering the Fate Price resolver. This is deliberate: `sourceName=cardmarket` alone cannot prove whether data came from the approved public-download route or another restricted route.

## Pricing source review — 2026-09-03

This is engineering source governance, not legal advice. Re-review if provider terms/use change.

### Approved V1

**Cardmarket public downloadable catalogue/price-guide files only.**

Use only official public download artifacts from `downloads.s3.cardmarket.com`. Do not scrape Cardmarket HTML and do not treat authenticated API access as covered by this approval.

Official Cardmarket material states the public catalogue/price parameters may be imported/incorporated into applications, and its download pages cover Pokémon, One Piece and Lorcana.

Exact One Piece/Lorcana direct artifact URLs have not been hardcoded because the current environment could not independently resolve the official hrefs. Verify those official hrefs in Codespace; do not guess game IDs from third-party examples.

### Blocked / approval required

- **Pokémon Wizard:** benchmark/UX reference only. Do not scrape or ingest pricing without explicit permission/licensing.
- **TCGplayer:** approval required for intended FateDrop commercial/aggregation use.
- **Cardmarket authenticated API:** not the approved V1 acquisition route.

## Production audit — canonical catalogue

Read-only Neon inspection on 3 September 2026 showed:

- Pokémon: 1 verified set only — Darkness Ablaze.
- Darkness Ablaze declares `total=201`, but has 1 verified canonical printing and 2 exact identities.
- Collector-ready Pokémon sets: 0.
- One Piece verified canonical sets: 0.
- Lorcana verified canonical sets: 0.

Do not expose Fate Collectors completion from production catalogue data yet.

## Existing catalogue machinery — reuse it

Pokémon already has:

- TCGdex client/adapter;
- Pokémon TCG API client/adapter;
- cross-source reconciliation;
- verified bulk sync;
- snapshot compilation/loading;
- `npm run trader:catalogue`;
- `npm run trader:catalogue:compile`;
- `npm run trader:catalogue:load`.

The sync CLI is plan-only unless `--write` is explicitly supplied; writes are also guarded by `FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true`.

Do not create another Pokémon catalogue provider.

One Piece has `one-piece-contract.mjs`; complete its proven catalogue/variant ingestion instead of guessing parallel/finish identity.

Lorcana needs a canonical catalogue adapter/provider using the same fail-closed identity rules. Do not add Lorcana-specific ownership tables.

## Production audit — Fate Value persistence

The repository already contains:

- `database/fate-value-market-history.sql`;
- source-agnostic market observations;
- transactional Postgres market persistence;
- Cardmarket catalogue/price-guide adapters and mapping infrastructure.

But read-only production Neon inspection showed the corresponding `fatedrop_market_*` tables are **not currently deployed**.

Do not deploy this schema as part of this branch without separate review. Test it on a temporary/test Neon branch first.

## First actions for Sol / Codespace

From `signal-engine` on this exact branch:

1. Run `npm test`.
2. Fix all syntax/integration/regression failures before extending scope.
3. Specifically run/review the new Fate Collectors, Cardmarket multi-TCG, provider-policy, Fate Price, checklist-price, set-value, collection-value and movement tests.
4. Run `npm run trader:catalogue` **without `--write`** and save/review the Pokémon plan.
5. Review matched, ambiguous, rejected, source-error and unmatched set groups.
6. Prove a complete verified Pokémon catalogue can be compiled/loaded/synced through the existing guarded path.
7. Re-run `npm run collectors:readiness -- --tcg=pokemon`.
8. Verify the official Cardmarket public download hrefs for Pokémon, One Piece and Lorcana.
9. Test `fate-value-market-history.sql` on a temporary/test Neon branch only.
10. Build the read service that joins market observations to ingest-run `providerPolicyKey` and feeds `resolveFatePrice`.
11. Add explicit FX handling only if/when FateDrop needs GBP display from EUR evidence; preserve both source currency/rate provenance and never silently convert.
12. Implement transactional Confirm Import writes across collection ownership + import provenance.
13. Populate One Piece canonical singles catalogue.
14. Add Lorcana canonical catalogue ingestion.

## Confirm Import rules

- Only `exact` matches may auto-apply.
- `needs_confirmation`, `ambiguous`, `unresolved` remain review states.
- Never auto-delete stale rows.
- Same source record updates rather than duplicates.
- Graded quantity >1 must split into individual physical items or use an explicitly confirmed safe flow.
- Do not guess variant, finish or language.

## Verification before any merge proposal

- `npm test` green in Codespace/CI.
- Existing catalogue/value tests green.
- New Fate Collectors tests green.
- Test DB migrations reviewed on a temporary branch.
- Pokémon catalogue readiness report reviewed.
- Representative Collectr files tested: duplicates, ambiguous variants, graded cards, missing numbers and repeat imports.
- Fate Price provenance join proven.
- No `main` merge.
- No production deployment.

## Product principle

`Import collection → FateDrop identifies owned cards → calculates set completion → shows only missing cards → automatically values owned/set/missing cards → later FateMatch finds them.`

Less work for the collector. No scrolling 1–200 cards to discover gaps. No purchase-price admin. No fake precision.