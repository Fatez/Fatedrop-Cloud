# Local Radar location-quality review — 2026-09-01

Review state only. No production rows were written, updated, or deleted.

## Read-only production census

The census read all 2,318 rows from `fatedrop_retailer_locations` in the production Neon database and applied the review classifier and reconciliation logic in memory.

| retailer | raw total | current public before | eligible after | directory-only | excluded | unresolved | duplicates reconciled | child services reconciled | Echo-eligible after | public delta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| tesco-uk | 1,715 | 1,715 | 1,009 | 71 | 600 | 35 | 598 | 71 | 0 | -706 |
| argos-uk | 422 | 422 | 416 | 0 | 6 | 0 | 6 | 0 | 0 | -6 |
| entertainer-uk | 125 | 125 | 122 | 0 | 3 | 0 | 3 | 0 | 0 | -3 |
| asda-uk | 48 | 48 | 48 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| travelling-man-uk | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| jet-cards | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| smyths-uk | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| the-card-vault-uk | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| total-cards | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **2,318** | **2,318** | **1,603** | **71** | **609** | **35** | **607** | **71** | **0** | **-715** |

Public retention is 69.2%. This is below the provisional 85%/2,000-branch target. The delta is evidence-backed rather than an unknown-format collapse: 607 rows reconcile as duplicates, 71 service children reconcile to parents, 35 service children fail closed because their parent is ambiguous, and two service rows have no safe parent. Zero obvious pharmacy, petrol/fuel, locker, service-counter, or closed rows remain eligible.

## Classification reasons

- `canonical_retail_branch`: 1,596
- `branch_tcg_verified`: 7
- `duplicate`: 607
- `pharmacy`: 50
- `petrol_station`: 23
- `pharmacy_parent_ambiguous`: 33
- `petrol_station_parent_ambiguous`: 2

## Representative removals and reconciliations

- `Tesco Extra Petrol Station` → `directory-only`, reconciled to canonical parent `loc_86a3ef065795b581a04c891e`.
- `Tesco Pharmacy` → `unresolved` where more than one nearby canonical Tesco parent remains plausible.
- Repeated nearby `Tesco`/`Tesco Extra` OpenStreetMap points → `duplicate_of` the strongest canonical row.
- Six Argos and three Entertainer duplicate rows → `duplicate_of` their retained canonical branch.

No raw location was deleted. Reconciliation attaches review-only relationship metadata (`duplicate_of` or `child_service`) to the in-memory projection.

## Echo authority

The current production rows produce zero branches under the new strict Echo gate. Existing legacy events do not contain the complete new `exactBranch + explicitTcgRelevance + fresh expiry` contract. This is a fail-closed migration state, not a reason to weaken the gate. A newly captured Entertainer campaign snapshot will create event-scoped `Echo · Expected` evidence with those fields after explicit deployment approval.

## Truth preservation

The audit used read-only `SELECT` operations. Raw locations, stock observations, stock episodes, signal events, and lifecycle history were unchanged. Location classification does not create Manifested or Vanished. Expired physical evidence becomes `Echo · No longer confirmed` only.
