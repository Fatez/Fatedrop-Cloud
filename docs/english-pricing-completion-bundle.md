# One-run English pricing recovery

Run **English Pokemon Pricing Completion Bundle** on main. Leave resume_run_id empty on the first run.
This replaces separate manual launches of eight recovery/audit stages. It does not restart catalogue activation.

The job downloads the official Cardmarket catalogue and guide once each, loads pinned TCGdex evidence once,
and invokes the existing baseline-ID, strict root-ID, attack/ability, legacy metadata and sibling-finish builders.
It also runs the mapped residual, duplicate-mapping and holo-evidence checks.
All builders execute inside a PostgreSQL repeatable-read READ ONLY transaction. No persistence functions are invoked.

The combiner rejects cross-stage product/identity conflicts, language/finish mismatches, ambiguous TCGdex links,
collector/name conflicts, unsupported baseline finishes and the eight first-edition quarantines.
A missing price never removes a binder card.

## Output

Download artifact english-pricing-bundle. bundle.json accounts for every currently unpriced verified English
standard/holo identity, including those without TCGdex links. It separates:
- existing mappings ready for current ingestion;
- new exact mapping proposals with a supported price;
- new mapping proposals without a supported price;
- mapped cases still needing review/provider data;
- unmapped cases still needing evidence.

Per-stage files retain detailed reasons and evidence. source-snapshots.json retains the exact downloaded source artifacts.
The bundle is **review_required**, never a claim of production activation or complete UK coverage.
Current pricing readiness uses the existing reviewed price policy; proposed mappings require separate review before activation.

## Resume and release

If a stage fails, other stages continue, the job finishes red, and completed checkpoints are retained.
Supply that GitHub run ID to resume. Checkpoints are reused only when code SHA, source hashes, TCGdex revision,
database inventory/mappings and priced-identity baseline match, and the saved output digest validates.
Changed inputs cause recomputation, not unsafe reuse. A new run still downloads each source once to validate its current hash/freshness.

Review the one combined bundle and its failures. Resolve any remaining evidence conflicts before adapting accepted candidates
to the existing guarded mapping activation path. Run the existing price ingestion and production recount afterwards.
This job deliberately exposes no activation toggle: an unreviewed combined proposal is not automatically authorised to write.
Do not rerun completed catalogue imports, loosen matching or invent reverse-holo prices to increase coverage.
