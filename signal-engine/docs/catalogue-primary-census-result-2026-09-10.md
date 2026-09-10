# Primary catalogue census result — 2026-09-10

Run: https://github.com/Fatez/Fatedrop-Cloud/actions/runs/34477512622
Artifact: https://github.com/Fatez/Fatedrop-Cloud/actions/runs/34477512622/artifacts/10152128772
Source revision: e36a155168d02590b69b1c92429a9877e04377d8
Artifact ZIP SHA256: 9d95cbced137858456f64d1e55710c0d44638c29aad925b9c798c98712ef5c84

The full source census and artifact upload succeeded. No database access or production writes.

| Measure | Count |
| --- | ---: |
| Source sets | 221 |
| Source card files | 23,650 |
| Unique source card IDs | 23,650 |
| Records with explicit English names through hierarchy | 23,548 |
| Physical records with explicit English names | 21,068 |
| Explicit normal/holo/reverse finish candidates outside edition/set holds and digital sets | 22,632 |
| English-named records without explicit normal/holo/reverse finish declarations | 8,565 |
| English-named first-edition records | 938 |

These counts are not additive. English names alone do not prove release eligibility. Source records are not finish-expanded verified identities. The 22,632 count excludes unknown finishes, first-edition holds and digital sets; it is neither a production count nor a new activation target. Existing production can legitimately contain more identities because it uses additional verification evidence.

Complete canonical identity cardinality remains unresolved. Do not subtract these raw source counts from the reported production identity count. The 74,000 target has not been substantiated.

Next step: reconcile the inventory's source IDs and held/unknown variant records against existing verified evidence and production mappings, read-only. Classify already present, absent, conflicting and held records before compiling a delta. Do not rebuild production or bypass the existing verification/activation path.

Local fixture checks passed: unique records, explicit finishes, missing finish remains unknown, first-edition hold, null verified denominator, duplicate source-set rejection. The successful remote run validates loading the real pinned source tree.
