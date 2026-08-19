# FateDrop Cloud Release Candidate v1

This branch consolidates the previously isolated Cloud workstreams into one reviewable release line. It does not deploy or modify Railway by itself.

## Included

- UK retailer intelligence registry/runtime foundation
- structured Shopify/WooCommerce qualification adapters
- safe retailer discovery/qualification/dry-run workflow
- True Price postage preservation and objective RRP delta context
- public RRP provenance fields in catalogue and True Price APIs
- hosted FateFind/FateMatch evaluator and durable notification outbox
- push/web/Discord delivery orchestration with opt-out and quiet-hours behaviour
- continuous Pokémon Center browser collector with complete-catalogue protection
- queue/security/access-control state detection without bypass behaviour
- combined Signal Engine + collector CI and high-severity production dependency audits

## Production safety

- `FATEDROP_RETAILER_REGISTRY_ENABLED=false` by default
- `FATEDROP_HOSTED_FATEFIND_ENABLED=false` by default
- no automatic database migration
- no automatic retailer candidate promotion
- no access-control bypass logic
- unknown postage remains unknown
- incomplete Pokémon catalogue walks are not ingested

## Database state

The launch-critical Wishlist/preferences/hosted-notification migration was tested on a temporary Neon branch and deliberately applied to production on 19 August 2026 after explicit approval.

The retailer registry migration remains unapplied and should stay separate until the Intelligence Centre activation phase.

## Remaining release proof

- exact-head CI on this consolidated branch
- Railway release-candidate deployment/config review
- hosted FateFind end-to-end test with evaluator initially disabled
- real Expo push test
- Discord delivery/account-link test if Discord is marketed at launch
- deployed API/browser smoke test
- real iPhone and Android device QA
