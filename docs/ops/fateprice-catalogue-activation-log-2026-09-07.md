# FatePrice catalogue activation log — 2026-09-07

Goal: push every clean Pokémon set through the same exact catalogue rules that made Pokémon 151 work, while recording failures for later repair instead of weakening identity safeguards.

## Progress

- Run `34075869892` — failed before bundle build because a fresh Prismatic Evolutions Pokémon TCG API request returned HTTP 502. No catalogue write occurred.
- Commit `0db947f993c8703d6f9d1bd5ef0d34c4dc253571` — removed the live Prismatic refetch from the activation critical path and reused its retained 180/180 exact proof.
- Run `34083271195` — Prismatic retained proof passed, but bundle assembly stopped at 77 sets because recovered clean artifacts were stored as `recovery-result.json` and were not being read. No catalogue write occurred.
- Commit `8dbf4734ea56ae6734937e4c24703517efa26b22` — added recovered clean set results to bundle assembly.
- Run `34083474722` — SUCCESS. Exact activation bundle built: 91 sets, 11,595 printings, 17,312 verified card identities, 17,312 card source mappings, 34,624 provenance rows. Fuzzy matching disabled. Production writes 0.
- Artifact `10004449370` — `fateprice-catalogue-activation-bundle`, digest `sha256:eac64ae7df2951bf9f05621d3f1d2a5e652c2a2b55fe5464be96014dc015f492`.
- Commit `ed61e75e15fd461346832feb601c717afd660e3e` — added `load-activation-bundle-cli.mjs`, which validates the bundle, splits it by set, and uses the existing `persistVerifiedCatalogueBatch` path set-by-set.
- Run `34084194961` — SUCCESS. All 91 clean sets split through the exact loader and focused catalogue tests passed.
- Direct Neon rehearsal preflight — existing rehearsal branch baseline remained 7 set rows / 1,024 identities. All 182 incoming set-source mappings were checked against persisted mappings; zero set-source conflicts found.
- Run `34084870598` — failed before database connection because GitHub has neither `NEON_API_KEY` nor `NEON_API_TOKEN`. No database write occurred.
- Commit `ddec699a1bc2c3feed9ecaf8461d63c538ed1951` — tried the isolated Neon compute's reported passwordless mode without adding credentials to GitHub.
- Run `34084943148` — failed at PostgreSQL authentication (`SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`). Passwordless compute metadata is not sufficient for a normal `pg` client connection. No database write occurred.

## Current truth

- Clean activation tranche proven: **91 sets / 17,312 identities**.
- Loader validation: **passed**.
- Set-source conflict preflight on isolated Neon branch: **passed**.
- Isolated Neon rehearsal persistence: **not yet completed**.
- Production persistence: **not yet completed**.
- Production endpoint visibility: **not yet verified**.

## Issues held for later repair

- Remaining matched/rejected/unmatched Pokémon sets outside the current clean 91-set tranche must continue through exact reconciliation after activation of the clean tranche.
- No fuzzy identity matching is permitted.
- Finish-specific price gaps, image coverage and daily market history remain separate coverage passes after catalogue activation.
- Two temporary Neon query-tuning branches were created during connection diagnostics (`br-holy-sea-ax08atgi`, `br-solitary-mountain-ax3d09wx`). They require explicit cleanup approval and have not been touched further.

## Next execution gate

Persist the exact 91-set bundle to the isolated Neon rehearsal branch using a credential-safe path, verify counts and referential integrity, then apply the same verified batch to production and prove public FatePrice visibility. Continue processing every remaining Pokémon set afterward, logging each rejected/conflicted set rather than blocking the clean majority.
