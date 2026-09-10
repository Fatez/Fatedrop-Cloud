# Catalogue completion: worker execution contract
Owner instruction: finish the complete primary physical Pokémon catalogue; minimise repeated audits and report concrete gaps. Do not pursue an unproven 50k/74k number.

## Start here
1. Inspect PR #447 and current main. Preserve any newer accepted exact mappings from other work. Merge this foundation only after CI passes; never overwrite main or reset production.
2. Run **Catalogue completion runner** (.github/workflows/catalogue-completion-runner.yml) on the reviewed merged commit. One dispatch runs tests, the pinned primary inventory, existing all-matched-set PostgreSQL rehearsal/replay and full inventory coverage accounting. It has no production credentials.
3. Download **catalogue-completion-evidence**. Read primary-coverage-summary.md first, then the ledger and rehearsal failures. A green rehearsal is NOT proof that the catalogue is complete.
4. Work from that ledger only. Do not start another source-universe audit or add providers to inflate counts.

## What each status means
- explicit_finishes_mapped: the raw primary record's explicit normal/holo/reverse finishes have exact verified mappings in rehearsal. This does not prove every possible edition/stamp.
- partially_mapped: at least one exact mapping exists but explicit finishes remain absent.
- not_mapped: no verified same-language mapping in rehearsal; investigate the set crosswalk and existing evidence first.
- mapped_finish_scope_unresolved: source card maps, but raw finish declarations are absent. Reconcile existing materialized API evidence/inheritance; do not guess standard.
- intentional_hold: preserve first-edition/edition safeguards. Document the edition model blocker; never count these as live.
- language_evidence_required: English-name hierarchy absent. Needs scope evidence, not invented translation/release eligibility.
- outside_physical_scope: digital Pocket record; not part of this physical-card release.

The census is a pinned repository inventory. The legacy rehearsal still uses versioned cached/live TCGdex API evidence, which can differ from that repository snapshot. Report source drift explicitly; do not call these one identical snapshot or silently accept the union. The ledger lists mappings outside the census.

## Resolve gaps without repetitive crawling
Reuse the existing caches and source mappings. Fix all records sharing a proven failure class together, with exact pair/value bounds and tests. Run cheap targeted tests before the next full rehearsal. On transient provider failures, rerun the same workflow: downloaded evidence is retained, although disposable PostgreSQL is rebuilt. Do not spend repeated full runs on unchanged reconciliation failures.

Card existence and price availability are separate. A verified unpriced card remains in scope and should be available for ownership tracking; unknown price is never £0. Do not require a retailer offer to establish card existence. This runner does not establish current price coverage.

## Release
Use **OPS FatePrice Full Pokemon Catalogue Production** with activate=false first, on the reviewed merged commit. Inspect its fresh production compatibility artifact. Fix exact conflicts rather than altering old IDs or deleting rows.
Only then use the existing guarded activate=true path, with the user's production authorization and all guards intact. Recount production, replay, orphan/duplicate checks and production-only rows.
Verify the app-facing catalogue/collection APIs expose activated cards through era/set pagination, search and exact identity lookup, including unpriced cards. Database insertion alone is not 'live in the network'.

## Required user report
Link one run and artifact. Report source card records separately from verified identities, source mappings and priced identities. Give:
- newly added and total production-verified identities (or 'not measured' before production checks);
- full-inventory statuses from the ledger;
- remaining blocker classes with exact IDs/counts;
- duplicate/orphan checks and replay;
- code / CI / merged / activated / production verified stage.
Never report all cards complete merely because the matched crosswalk passed.

## Remaining engineering, not hidden by this foundation
This runner cannot automatically prove unsupported editions or resolve conflicting source evidence. Those records need exact evidence/model work. It does not change production verification policy, trigger activation or prove every language. The immediate scope remains the existing English physical catalogue; language expansion needs its own denominator.
