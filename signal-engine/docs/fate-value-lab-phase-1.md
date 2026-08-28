# Fate Value Lab — Phase 1

## Purpose

Phase 1 creates a quiet, internal market-evidence ledger for collectible cards. It does **not** expose a public Fate Value and it does **not** change Fate Trader behaviour.

The goal is to start accumulating trustworthy, replayable market history while FateDrop beta work continues independently.

## Canonical identity

Fate Value does not create another card catalogue.

- `fatedrop_card_identities.id` / `fateCardId` remains the canonical exact printed identity.
- External provider IDs remain crosswalks in `fatedrop_card_source_mappings`.
- A market observation may enter canonical history only when its provider record resolves through an existing exact source mapping to an already verified FateDrop card identity.
- Condition is evidence about a market or physical copy and is never encoded into `fateCardId`.
- Unresolved evidence is retained in `fatedrop_market_ingest_rejections`; identity is never guessed to increase coverage.
- Market data is downstream evidence. It cannot create, repair or reinterpret canonical card identity.

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

## Cardmarket adapter boundary

Cardmarket is the first provider adapter. Cardmarket publishes its product catalogue and price-guide downloads publicly, so Phase 1 is designed around those download artefacts rather than account credentials, private API access or page scraping.

The adapter is deliberately split in two:

1. `cardmarket-catalogue-adapter.mjs` stages provider product evidence only. It has no authority to produce a `fateCardId`, collector number or FateDrop variant.
2. `cardmarket-adapter.mjs` converts a price-guide row into market evidence only after an exact verified source mapping has been supplied.

The price guide can contain standard and holo metrics in the same provider row. Those lanes are never merged or automatically interpreted as FateDrop variants. Each meaningful lane must resolve explicitly. Zero-only placeholder lanes do not become market observations.

Provider snapshot identity comes from the provider's own version/timestamp rather than FateDrop's ingest time. This keeps retries idempotent and prevents the same daily source file being recorded as several different market days merely because it was processed more than once.

## Explicitly out of scope for Phase 1

- Fate Fair Value formula
- good-buy / fair-sale / quick-sale bands
- GBP conversion
- price forecasts
- public API/UI exposure
- Fate Trader trade-balance changes
- collection valuation
- scanner/camera recognition
- automated page scraping
- market data creating or changing canonical card identities

## Phase 1 exit gate

Phase 1 is ready for a provider rehearsal when all of the following are true:

1. schema is migration-reviewed against a non-production database branch;
2. observation normalisation/persistence tests pass;
3. exact source mappings are required before canonical market insertion;
4. unresolved rows are retained without guessing;
5. identical snapshot replays are idempotent;
6. changed evidence cannot mutate previously stored observations;
7. source-native currency and raw evidence are preserved;
8. Cardmarket standard/holo lanes cannot cross-map implicitly;
9. Cardmarket catalogue evidence cannot create canonical FateDrop identity;
10. no public product behaviour changes.

The next database-backed engineering slice is a **small Cardmarket catalogue crosswalk + price-guide rehearsal** against deliberately selected Pokémon examples before any full-catalogue ingestion. Database rehearsal remains mandatory before that slice is allowed to write anything.
