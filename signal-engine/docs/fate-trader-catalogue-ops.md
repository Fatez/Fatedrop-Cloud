# Fate Trader English Pokémon catalogue operations

The catalogue pipeline is evidence-first and fail-closed. It does not scrape collector websites into FateDrop identities and it never treats upstream IDs as FateDrop IDs.

## Sources

- TCGdex (`en`) supplies the catalogue walk and explicit finish-variant evidence.
- Pokémon TCG API supplies independent English set/base-printing corroboration.
- Collector indexes such as Pokéllector may be used only for coverage QA and manual conflict investigation.

## Read-only coverage plan

From `signal-engine`:

```bash
npm run trader:catalogue
```

This is the default mode. It reads both source catalogues, builds the strict crosswalk and prints:

- source set counts
- verified matched set pairs
- ambiguous same-name candidates
- rejected/conflicting set pairs
- sets present in only one source
- a conflict-field breakdown

It does not open a database connection or mutate FateDrop.

### Preview an exact verified batch

Use TCGdex source set IDs with `--sets` to preview the precise batch that would be eligible for a later write:

```bash
npm run trader:catalogue -- --sets=sv03.5,sv04.5,sv08.5
```

Every requested set must already belong to the verified crosswalk. Unknown, unresolved, duplicate, digital Pocket or otherwise unverified set IDs are rejected rather than guessed.

## Controlled writes

Writes require two independent operator decisions:

1. the `--write` CLI flag
2. `FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true`

`DATABASE_URL` is also required. For a targeted batch, prefer explicit set IDs rather than relying on catalogue ordering:

```bash
FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true \
  npm run trader:catalogue -- --write --sets=sv03.5,sv04.5,sv08.5 --max-cards=100
```

Whole-catalogue bounded writes remain available when intentionally required:

```bash
FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true \
  npm run trader:catalogue -- --write --max-sets=5 --max-cards=100
```

Optional set-boundary resume:

```bash
FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true \
  npm run trader:catalogue -- --write --start-after=<tcgdex-set-id> --max-sets=5
```

The whole-catalogue runner reuses the tested per-set `syncVerifiedPokemonSet` path. A failed set is safe to restart from its beginning because canonical persistence is deterministic/idempotent. The error output includes the last completed set cursor.

## Rules

- Run the read-only plan against live sources before enabling bulk writes.
- For production bootstrap, prefer explicit `--sets` batches so the exact intended sets are auditable before mutation.
- Review ambiguous and rejected set pairs before describing coverage as complete.
- Do not add broad fuzzy aliases to improve the match percentage. Any alias must be narrow, evidence-backed and regression-tested.
- Only matched card evidence is promoted to `verified`.
- First-edition composition remains quarantined until edition + finish is modelled correctly.
- English is V1. Other languages require an independent language-appropriate corroborating source.
- Do not enable Trade Network / matching merely because catalogue rows were added.
