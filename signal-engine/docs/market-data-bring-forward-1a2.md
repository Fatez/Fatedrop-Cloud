# Market Data Bring-Forward — Phase 1A.2

Status: engineering foundation only. Not merged, not deployed, and not authorized to write production market history.

## Objective

Move Fate Value market evidence from a laboratory/rehearsal path into a repeatable, auditable input for Market Pulse without creating a second identity system or a speculative valuation policy.

The target chain is:

`approved source artifact -> exact source mapping -> append-only market history -> readiness audit -> Market Pulse 1A`

This phase deliberately does **not** define FatePrice/Fate Fair Value, heat scoring, volatility scoring, demand scoring, or public UI policy.

## Existing safety boundary retained

- Canonical card identity remains `fatedrop_card_identities`.
- External provider identity remains `fatedrop_card_source_mappings`.
- Only mappings to `verification_status='verified'` cards may become market observations.
- No fuzzy/global fallback is allowed when an exact mapping is absent.
- Unresolved evidence is quarantined as an ingest rejection rather than attached to the nearest-looking card.
- Provider currency is preserved. No hidden FX conversion occurs in ingestion.
- Provider price metrics are stored as evidence. They are not silently renamed to a FateDrop fair value.
- Provider snapshots are append-only/idempotent. Replaying the exact snapshot cannot mutate historical evidence.

## Cardmarket daily path

The initial live-source adapter is the approved Cardmarket Pokémon catalogue/price-guide path already present in Fate Value Lab.

`cardmarket-source-client.mjs` owns transport controls such as HTTPS/host allowlisting, byte limits, JSON validation, freshness checks and provider snapshot metadata.

`cardmarket-daily-ingest.mjs` now owns the deterministic daily handoff:

1. accept the already-validated Cardmarket price-guide payload;
2. ask only for meaningful Cardmarket price lanes;
3. translate provider lane to explicit source-mapping key:
   - `standard -> normal`
   - `holo -> holo`
4. resolve that exact `source_name + source_record_id + source_variant_key` mapping;
5. require the mapped FateDrop card identity to be verified;
6. build observations/rejections through the existing Cardmarket adapter;
7. persist through the existing immutable Fate Value market ledger.

The `normal`/`holo` values above are Cardmarket source-mapping keys. They do **not** redefine FateDrop canonical card variants.

No network fetching is hidden inside the persistence helper. Fetch/validation and persistence remain separable so a source artifact can be rehearsed before it is written.

### Dry-run-first market cycle

`cardmarket-market-cycle.mjs` composes the hardened source fetch, exact mapping, batch preparation and readiness audit into one operator-facing function.

Its default mode is `dry-run`:

- source transport and freshness checks still run;
- the artifact SHA-256 and provider snapshot identity are reported;
- accepted/rejected lane counts are calculated;
- no market ledger mutation is authorized;
- current readiness is returned alongside the proposed batch result.

Persistence requires the caller to explicitly select `mode: 'persist'`. There is no automatic scheduler in this phase and no production invocation is added by this branch.

## Readiness audit

`market-data-readiness.mjs` is a read-only gate for both file-backed development state and PostgreSQL.

It reports, per source:

- whether the canonical card schema is available;
- whether the complete market-history schema is available;
- verified TCG/set/card counts;
- verified cards with exact source mappings;
- mappings that target staged/missing identities;
- unmapped verified cards, bounded reconciliation examples and mapping coverage percentage;
- mapping coverage by TCG and set;
- ingest-run, observation and rejection counts;
- rejection counts grouped by reason code;
- stored observation count and distinct market days;
- earliest/latest market day;
- currently represented market lanes;
- exact 1-day, 7-day and 30-day baseline coverage from the latest market day;
- explicit issue codes such as `market_history_schema_missing`, `source_mapping_coverage_incomplete`, `source_mapping_targets_unverified`, `ingest_rejections_present` and `d7_baseline_coverage_incomplete`.

It does not emit a synthetic confidence score.

## Production observation — 3 September 2026

A read-only Neon inspection found:

- canonical card identity tables are present;
- `fatedrop_market_*` history tables are not currently deployed on the inspected production branch;
- the newer verified canonical card-identity layer is still very small and therefore is not ready to represent the wider FateDrop market catalogue.

This branch does not change that production state.

## Market-history schema deployment gate

The schema already exists at:

`signal-engine/database/fate-value-market-history.sql`

It creates the append-only ingest-run, market-observation and rejection tables plus supporting indexes. It references the existing canonical card identity/source mapping tables with restrictive foreign keys.

### Required order before production deployment

1. **CI rehearsal**
   - Apply `fate-trader-card-identity.sql` and `fate-value-market-history.sql` to disposable PostgreSQL only.
   - Run persistence, replay/idempotency, Pulse read and readiness smoke tests.

2. **Catalogue readiness**
   - Expand verified canonical card coverage deliberately.
   - Do not count staged/unverified cards as market-ready.

3. **Source mapping readiness**
   - Build/confirm Cardmarket source mappings against verified canonical cards.
   - Use the existing manual crosswalk diagnostics for unresolved products/variants.
   - Do not auto-confirm a candidate because its name or collector number looks close.

4. **Temporary Neon branch rehearsal**
   - Apply the schema to a temporary branch.
   - Validate foreign keys, indexes, idempotent ingest and readiness queries against realistic volume.
   - Confirm no existing canonical tables are mutated unexpectedly.

5. **Explicit production approval**
   - Production schema application is a separate authorized action.
   - This phase does not grant that approval.

6. **Silent history soak**
   - Start Cardmarket ingestion without public Pulse output.
   - Record accepted/rejected counts, mapping gaps, newest source timestamp and history depth.
   - Reconcile rejects rather than loosening identity rules.

7. **Pulse evidence gate**
   - Do not treat 1D/7D/30D movement as broadly representative until exact baseline coverage is visible and acceptable for the intended game/set scope.
   - Missing baseline stays missing; nearby dates are not substituted.

## Historical-data boundary

The current Cardmarket price-guide artifact is treated as a dated provider snapshot. Phase 1A.2 does not fabricate historical daily snapshots from rolling `avg1`, `avg7` or `avg30` fields. Those provider metrics remain evidence fields, not replacements for FateDrop's own exact daily observations.

Therefore exact D1/D7/D30 Pulse history matures as dated snapshots accumulate unless a separately verified historical source/backfill is approved later.

## Operational measurements to watch

The most important readiness numbers are:

- verified canonical cards;
- exact Cardmarket-mapped cards;
- mapping coverage %;
- mappings targeting non-verified identities;
- unresolved/rejected source lanes and rejection reasons;
- latest provider effective timestamp;
- distinct stored market days;
- current market-lane count;
- exact D1/D7/D30 lane coverage %.

A green ingestion job with poor mapping or baseline coverage is **not** a green Market Pulse dataset.

## Multi-TCG boundary

The market ledger, readiness audit and Pulse aggregation remain game-agnostic. The current approved Cardmarket source client is specifically wired to the Pokémon Cardmarket artefacts. One Piece and future TCGs must enter through their own verified catalogue/source adapters and exact mappings; they must not be forced through Pokémon-specific provider assumptions.

## Handoff after 1A.2

Once the schema is safely rehearsed, catalogue/mapping coverage is materially expanded, and silent daily history has enough exact baselines, the next phase can build evidence-based:

- market heat;
- volatility;
- movers;
- heating/cooling sets;
- liquidity/sales-velocity signals when a trustworthy source exists;
- demand signals from appropriately aggregated FateDrop behaviour.

Those scores should consume this ledger; they should not invent a parallel price history.
