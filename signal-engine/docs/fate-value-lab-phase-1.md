# Fate Value Lab — Phase 1

## Purpose

Phase 1 creates a quiet, internal market-evidence ledger for collectible cards. It does **not** expose a public Fate Value and it does **not** change Fate Trader behaviour.

The goal is to start accumulating trustworthy, replayable market history while FateDrop beta work continues independently.

## Canonical identity

Fate Value does not create another card catalogue.

- `fatedrop_card_identities.id` / `fateCardId` remains the canonical exact printed identity.
- External provider IDs remain crosswalks in `fatedrop_card_source_mappings`.
- A market observation may enter canonical history only when its provider record resolves through an existing exact source mapping.
- Condition is evidence about a market or physical copy and is never encoded into `fateCardId`.
- Unresolved evidence is retained in `fatedrop_market_ingest_rejections`; identity is never guessed to increase coverage.

## Phase 1 tables

### `fatedrop_market_ingest_runs`

Operational provenance for one immutable provider snapshot. Tracks source version, counts, completion state and source metadata.

### `fatedrop_market_observations`

Append-only mapped market evidence. Standard fields cover common price-guide signals while `metrics_json` and `raw_payload` preserve provider-specific evidence without forcing provider semantics into the shared model.

A logical observation is scoped by source, source snapshot, source record, source variant, market segment, condition and native currency. Reprocessing the same unchanged source snapshot is idempotent. Attempting to write different content into an existing logical observation is an error rather than an update.

### `fatedrop_market_ingest_rejections`

Audit queue for evidence that cannot safely enter canonical history, including unresolved or conflicting identity mappings.

## Currency policy

Raw market evidence is stored in the provider's native currency. Phase 1 performs no FX conversion.

Future GBP display/valuation may use a separately versioned FX observation so the original market evidence remains reproducible.

## Standard market fields

The source-agnostic observation contract currently supports:

- `marketPrice`
- `lowPrice`
- `trendPrice`
- `avg1d`
- `avg7d`
- `avg30d`
- `avgLifetime`
- `excellentPlusLow`
- provider-specific `metricsJson`
- original `rawPayload`

A provider adapter may populate only the fields it actually knows. Missing signals remain null/unknown.

## Explicitly out of scope for Phase 1

- Fate Fair Value formula
- good-buy / fair-sale / quick-sale bands
- GBP conversion
- price forecasts
- public API/UI exposure
- Fate Trader trade-balance changes
- collection valuation
- scanner/camera recognition
- automated provider scraping

## First provider adapter

Cardmarket is the intended first price-guide adapter because its downloadable catalogue/price-guide data maps well to the observation contract. The adapter must remain isolated from the shared model so another source can be added or substituted without changing FateDrop's canonical identity or market history.

Before any Cardmarket-derived values are exposed publicly/commercially, current provider terms/permissions must be resolved. Phase 1 is an internal data-foundation project only.

## Phase 1 exit gate

Phase 1 is ready for a provider rehearsal when all of the following are true:

1. schema is migration-reviewed against a non-production database branch;
2. observation normalisation/persistence tests pass;
3. exact source mappings are required before canonical market insertion;
4. unresolved rows are retained without guessing;
5. identical snapshot replays are idempotent;
6. changed evidence cannot mutate previously stored observations;
7. source-native currency and raw evidence are preserved;
8. no public product behaviour changes.

The next engineering slice after this foundation is a **Cardmarket catalogue crosswalk + price-guide adapter rehearsal** against a deliberately small Pokémon sample before any full-catalogue ingestion.
