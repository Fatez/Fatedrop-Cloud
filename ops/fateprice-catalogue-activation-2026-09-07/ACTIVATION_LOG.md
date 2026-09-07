# FatePrice catalogue activation log — 2026-09-07

Target: follow the proven Pokémon 151 exact-catalogue path for the broader verified set tranche. No fuzzy identity matching. No production shortcut around mapping conflicts. Keep issues for later review rather than blocking clean sets.

## Proven bundle
- Exact activation bundle: 91 verified sets.
- Verified identities in bundle: 17,312.
- Recovered set evidence included; stale live Prismatic refetch removed from the critical path.

## Rehearsal
- Isolated Neon branch: `br-proud-shape-axlh9tq9`.
- Secure one-run encrypted database handoff added after GitHub had no Neon API secret configured.
- First 46 bundle sets independently confirmed present and verified on the rehearsal branch before production activation.
- Referential checks observed zero orphan card→set and card→printing rows during rehearsal.

## Production halfway activation
- Production branch: `br-empty-bar-axch9b61`.
- Guarded workflow: `OPS FatePrice Catalogue Production Halfway`.
- Bounded loader added with `--limit=46`; full 91-set bundle is still validated before writes.
- Production baseline before this tranche: 4 verified sets / 1,024 verified identities.
- Activation in progress for the first 46 exact verified bundle sets.

## Issues encountered / retained for review
1. Earlier retained-artifact workflow referenced a stale artifact ID — removed.
2. Fresh Prismatic compile was blocked by upstream Pokémon TCG API HTTP 502 — replaced by already-retained 180/180 verified proof for activation.
3. Recovery bundle initially omitted `recovery-result.json` — fixed, restoring the 14 recovered clean sets.
4. GitHub Actions has no `NEON_API_KEY` / `NEON_API_TOKEN` secret — secure RSA one-run credential handoff implemented instead; credentials are not committed in plaintext.
5. Neon endpoint `passwordless_access` did not permit passwordless pg/SCRAM from GitHub Actions — secure credential handoff retained.

This log should be updated with final production counts and any set-level failures after the halfway activation finishes.
