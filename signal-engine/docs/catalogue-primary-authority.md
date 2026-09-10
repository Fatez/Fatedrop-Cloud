# Pokémon catalogue authority and denominator
Decision date: 2026-09-10

## Scope
TCGdex is the primary candidate-universe authority in the existing architecture: its set/card records drive reconciliation and its explicit variants supply finishes. Keep FateDrop-owned IDs, existing mappings, production rows and exact verification policy. Pokémon TCG data remains verification evidence; Cardmarket provides exact pricing/product evidence; retailers provide offers. Secondary-only discoveries are research candidates, never additions to the universe merely to increase counts.

This decision does not declare one-source records production verified. The existing requirement for independent verification must not be silently bypassed. Removing that requirement would need a separate reviewed verification model and compatibility rehearsal.

## Evidence from main
- pipeline.mjs iterates TCGdex cards; Pokémon TCG records are independent candidates.
- snapshot-compiler.mjs merges keyed rows and throws on identity collisions.
- tcgdex-adapter.mjs quarantines first-edition composition and absent explicit finishes.
- The existing remaining census subtracts a hard-coded 26,169 baseline from a 50,000 target; it does not prove source cardinality.
- The legacy raw snapshot extractor defaults missing normal to true. Do not use that inferred value as evidence of an explicit finish. This census reads raw declarations and leaves missing variants unknown.
- Pinned source revision: e36a155168d02590b69b1c92429a9877e04377d8. The non-truncated Git tree contains 23,650 data/<era>/<set>/<card>.ts files. This is a file inventory, not 23,650 verified English cards or 74,000 identities.

## One reproducible census
The primary-source workflow imports the full pinned source tree locally, with no API key and no database access. It reports every era/set, source card IDs, explicit English-name candidates, digital separation, explicit finish candidates and holds. Duplicate source keys abort rather than overwrite. Missing finishes do not become standard. Counts are research evidence only.

Read the artifact's limitations: names do not prove English release eligibility, raw declarations do not settle all inherited defaults, stamp/edition combinations are not flattened into production IDs. A complete verified identity denominator remains unknown until those are resolved. Do not add source mappings to identity totals.

## Execution order
1. Run the pinned primary-source census once and retain its artifact/revision.
2. Resolve eligibility and finish exceptions against existing evidence, grouped by era/set. Reuse cached evidence; do not restart broad provider crawls.
3. Read-only compare candidate natural keys with production: already present, new, conflicting, held. Preserve production IDs and existing enrichment.
4. Compile only the reviewed delta through the existing compiler/bulk loader. Rehearse compatibility and replay; require no duplicate or orphan identities.
5. Activate only through existing guarded atomic activation after review. Report sets, printings, identities, mappings and priced identities separately.
6. Later imports use pinned source revisions and exact source keys; secondary enrichment must resolve an existing identity or stay unresolved.

The eight existing set holds remain base2, base3, base5, gym1, neo1, neo2, neo3, neo4. Preserve Unseen Forces symbolic holds, exact language/finish/edition boundaries and unknown prices. No production migration or activation is part of this census PR.

## API key
Existing live source clients accept the Pokémon TCG API key for independent verification. It does not select a primary authority or increase the denominator. The source-universe audit reads POKEMON_TCG_API_KEY; the isolated rehearsal uses pinned Pokémon TCG repository data and does not need that key. Secret presence/value has not been inspected.
