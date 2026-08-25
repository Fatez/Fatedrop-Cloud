# Fate Trader English Pokémon catalogue operations

The catalogue pipeline is evidence-first and fail-closed. It does not scrape collector websites into FateDrop identities and it never treats upstream IDs as FateDrop IDs.

## Sources

- TCGdex (`en`) supplies explicit finish-variant evidence.
- `PokemonTCG/pokemon-tcg-data` supplies independent English set/base-printing corroboration.
- Collector indexes such as Pokéllector may be used only for coverage QA and manual conflict investigation.

## Preferred bootstrap path: pinned source snapshots

Large historical bootstrap should not walk public APIs card-by-card. Clone each source repository once, record its exact commit, extract local English snapshots, then compile the verified FateDrop catalogue entirely from local files.

Example:

```bash
git clone --depth=1 https://github.com/tcgdex/cards-database.git /tmp/tcgdex
git clone --depth=1 https://github.com/PokemonTCG/pokemon-tcg-data.git /tmp/pokemontcg

bun scripts/extract-tcgdex-snapshot.mjs \
  --repo=/tmp/tcgdex \
  --out=/tmp/tcgdex-en.json

node scripts/extract-pokemontcg-snapshot.mjs \
  --repo=/tmp/pokemontcg \
  --out=/tmp/pokemontcg-en.json

npm run trader:catalogue:compile -- \
  --tcgdex=/tmp/tcgdex-en.json \
  --pokemon=/tmp/pokemontcg-en.json \
  --out=/tmp/fatedrop-pokemon-catalogue.json
```

The compiled artifact stores the exact source commit for both repositories. The compiler reuses the same set reconciliation, card reconciliation, variant promotion and canonical FateDrop identity logic as the API path.

A set contributes **zero** compiled rows unless all TCGdex source cards reconcile against the independent Pokémon dataset, source card counts agree, and conflicts/quarantined/unmatched counts are all zero. A failed set is reported and excluded without blocking clean sets.

To compile only exact already-verified TCGdex set IDs:

```bash
npm run trader:catalogue:compile -- \
  --tcgdex=/tmp/tcgdex-en.json \
  --pokemon=/tmp/pokemontcg-en.json \
  --sets=sv03.5,sv04.5,sv08.5 \
  --out=/tmp/fatedrop-selected.json
```

## API path: coverage diagnostics and bounded fallback

The existing API runner remains useful for live coverage diagnostics, targeted source checks and bounded fallback work:

```bash
npm run trader:catalogue
```

This is read-only by default. It builds the strict crosswalk and prints source counts, verified matched pairs, ambiguous candidates, conflicts, source-only sets and source failures.

### Preview an exact verified API batch

```bash
npm run trader:catalogue -- --sets=sv03.5,sv04.5,sv08.5
```

Every requested set must already belong to the verified crosswalk. Unknown, unresolved, duplicate, digital Pocket or otherwise unverified set IDs are rejected rather than guessed.

## Controlled API writes

Direct API-driven writes remain gated and are not the preferred historical-bootstrap mechanism. They require both `--write` and `FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true`, plus `DATABASE_URL`.

```bash
FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true \
  npm run trader:catalogue -- --write --sets=sv03.5 --max-cards=100
```

## Rules

- Prefer pinned repository snapshots for historical bootstrap and large rebuilds.
- Preserve source commit provenance with every compiled catalogue artifact.
- Never persist a partially reconciled set.
- Review rejected sets independently; do not weaken global matching rules to inflate coverage.
- Do not add broad fuzzy aliases. Any alias must be narrow, evidence-backed and regression-tested.
- Only matched card evidence is promoted to `verified`.
- First-edition composition remains quarantined until edition + finish is modelled correctly.
- English is V1. Other languages require an independent language-appropriate corroborating source.
- Do not enable Trade Network / matching merely because catalogue rows were added.
