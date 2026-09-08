# Production catalogue activation recovery

## Confirmed diagnosis, 8 September 2026

Run 34242482989 passed the set crosswalk and public-key publication, then waited almost sixteen minutes for an encrypted database URL. All production baseline/write/verification steps were skipped. Production was checked directly: 91 verified sets, 11,595 printings, 17,312 verified identities; zero orphan set, printing or source-mapping references. This failure is not evidence of corrupted card mappings.

The operations branch has the same catalogue reconciliation/sync implementation as main. Its run-attempt filename fix addressed the earlier 422, but did not supply a credential producer. The replacement workflow removes this handoff dependency entirely; the previous fix is preserved in branch history.

## Secure setup and first run

1. In Fatez/Fatedrop-Cloud Actions repository secrets, configure `FATEPRICE_PRODUCTION_DATABASE_URL` from the approved Neon project `summer-truth-31037285`, production branch `br-empty-bar-axch9b61`, database `neondb`. Use the production connection with TLS. Never put this value in Git, issues, artifacts or chat.
2. Run the workflow on **main**, with `activate` left **false**. This only validates the credential and reads production baseline counts. It performs no source crosswalk or bulk writes. Do not retry the old operations-branch workflow.
3. Confirm credential preflight and baseline succeeded. If access is missing, fix secret configuration first. Do not run activation blindly.
4. Before bulk writes, rehearse the existing catalogue sync on an isolated Neon branch and retain the result. The production-only target validator must not be loosened to accept the rehearsal branch.
5. Run on main with `activate=true` only after the access check and rehearsal succeed. Existing crosswalk, 100-set first batch, remainder cursor, completion and referential gates remain in place. Concurrent production catalogue runs are serialized; a newer run never cancels an active writer.
6. Query production directly afterward. Report verified sets, printings, identities, mappings, priced identities and orphan/quarantine counts separately. A successful set crosswalk or processed-card count is not production completion.

The existing exact identity reconciliation and persistence remain unchanged. Missing prices remain unknown. Reverse-holo and other legitimate finishes remain distinct; this recovery does not discard low-value binder cards or substitute prices.

## Remaining limitations

This change does not configure the repository secret, perform activation or prove production expansion. GitHub secret management was not available through the connected tool and local GitHub CLI authentication was invalid during repair. No activation was launched. There is no new need to redo the existing 132-set audit.

The original sync still rebuilds its source crosswalk for each CLI invocation. That is separate from the sixteen-minute credential wait and is not changed in this bounded credential repair. Failed partial writes can be retried through the existing deterministic identities/upserts; preserve any reported resume cursor rather than interpreting attempts as newly created identities.
