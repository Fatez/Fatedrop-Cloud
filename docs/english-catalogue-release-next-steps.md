# English catalogue release: remaining execution

## Verified failed-run evidence

Run 34594808748 rehearsed 165 sets / 20,023 printings / 27,725 identities, with thumbnail URLs on all rehearsal printings and unchanged replay. Activation failed before writing on collector_number '043' versus '43' for the same printing ID.

Production in that run: 157 sets / 19,087 printings / 27,624 identities / 39,772 source mappings. Cardmarket: 18,668 observations / 5,012 observed identities; latest market day 2026-09-11. These are timestamped run counts, not perpetual live truth.

## Release execution

1. Wait for this change's release and PostgreSQL compatibility CI to pass; merge.
2. Launch OPS FatePrice Full Pokemon Catalogue Production on NEW main with activate=false. Do not re-run the old one-shot branch; it runs old code. Inspect compatibility report and all metadataDifferences.
3. If clean, use the existing guarded activation with activate=true and retain the post-commit recount. Do not adjust counts to suppress an unexplained mismatch.
4. Verify actual app set/checklist visibility. 165 matched sets does not by itself prove the entire English universe.
5. Existing printing artwork is preserved by insert-only activation. Rehearsal thumbnail coverage does not backfill existing production metadata. A separately rehearsed artwork backfill through persistVerifiedPrintingArtwork and production coverage recount remains necessary; do not claim all thumbnails live from rehearsal alone.

## Pricing and market tracking

The existing runCardmarketPokemonMarketCycle in signal-engine/src/trader/value/cardmarket-market-cycle.mjs fetches the guide, scopes it to verified Cardmarket normal product mappings, prepares the daily evidence batch and persists through persistMarketEvidenceBatch in persist mode. Reuse this path; do not create an overlapping price importer.

First capture a current read-only coverage report: English identities and printings, exact Cardmarket mappings, identities with valid current quotes, latest source day, and history coverage for each displayed movement window. Separate: missing mapping; mapped but missing guide row; unusable/stale observation; unsupported finish. More guide downloads cannot fix unmapped identities.

Expand mappings only from explicit exact evidence. Run the existing daily cycle after accepted mappings are activated, and compare accepted/rejected counts and priced identities before/after. Do not backdate new observations to fabricate history; preserve existing daily records. A quoted price is not proof of complete 7/30/90-day movement history. Keep unknown prices unknown, and preserve first-edition and reverse-finish holds.

Scanner is App PR #230: mobile CI passed, native build and real-device scan confirmation tests remain required. App PR #228 is the printing-only checklist companion; verify its release status before calling binder UX complete.
