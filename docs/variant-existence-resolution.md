# Variant existence and price resolution

This is a read-only classification engine, not a provider hydration service or an activation path.
It reuses FateDrop canonical identity IDs and does not create replacement card tables.

Run:
`node src/trader/value/variant-resolution-ledger-cli.mjs evidence/pokemontcg-finish-evidence-audit-34719433407.json ledger.json [reviewed-evidence.json]`

Without reviewed existence evidence, all 1,121 historical held identities correctly remain UNRESOLVED_EVIDENCE.
The saved pricing dictionary diagnostic distinguishes 1,081 alternate-finish cases and 40 empty-key cases.
Neither is evidence of nonexistence. Edition is recorded as unspecified for this historical input, never inferred as unlimited.

Optional reviewed-evidence JSON contains decisions, snapshots, prices.
Decisions require exact cardIdentityId, finish, language, edition; verdict exists/does_not_exist;
basis explicit_variant_record/exact_printing_checklist; reviewReference, sourceLocator, snapshotSha256.
Snapshots maps SHA256 to the exact raw UTF-8 response. Hashes establish integrity only.
The decision file is trusted reviewed input; these fields are not a substitute for substantive source review.
Do not generate an existence decision from generic null-valued subtype rows or rarity labels.

Prices require exact identity scope, provider/productId/subtype, currency, positive numeric amount,
observedAt epoch milliseconds, snapshotSha256, exactMappingVerified and mappingReviewReference.
The compound provider key includes subtype, language and edition. No FX conversion or Cardmarket
price attribution is performed. Default freshness window is seven days.
Prior snapshots are not deleted when current evidence is absent.

States:
- ACTIVE_PRICED: reviewed existence and supported current price.
- ACTIVE_UNPRICED: reviewed existence without a usable current price (including conflicting prices).
- INVALID_CATALOGUE_ENTRY: reviewed nonexistence; dependency review required, never automatic deletion.
- UNRESOLVED_EVIDENCE: insufficient/conflicting existence evidence.

These are proposed audit states, not claims that production was changed.
Before any catalogue correction inspect collection quantities, binder membership, wishlists, source mappings
and price histories referencing the identity. Preserve originals and obtain explicit authoritative evidence.
The ledger reports classified and resolved separately: classifying all rows is not 100% resolution.

Remaining integration: acquire and review provider/checklist evidence; run against a fresh production residual;
connect accepted decisions to the existing guarded mapping/price pipeline; independently verify production
and app read paths. No provider adapters, production migrations or UI changes are implied by this PR.
