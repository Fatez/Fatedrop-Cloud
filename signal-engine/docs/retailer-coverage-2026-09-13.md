# Retailer coverage release — 13 September 2026

## Changes and evidence

- JET Cards: the current Pokemon JSON collection extends beyond the six-page runtime cap. Public requests returned 250 products on pages 1–7 and 16 on page 8 (1,766 source products before sealed-product filtering). Raise only JET's cap to 12; the scanner must still observe an end page and keeps incomplete-catalogue safeguards.
- Existing sealed Shopify monitors: `single` incorrectly excludes `Single Booster Pack`, including hyphenated URL handles. Permit that exact sealed-pack phrase; preserve individual card, graded and accessory exclusions. Align qualification relevance with the live filter.
- Shuffled: reviewed exact Pokemon collection endpoint, one page with six products. Acquired live GB payload replayed through the existing normalizer and qualification summary: six accepted products, 100% known stock and finite-price coverage, no singles/accessories. A full network-adapter rehearsal runs in GitHub before activation; local network DNS validation prevented that adapter from running here, so payload replay is not claimed as production verification.

Public sources:
- https://jetcards.uk/collections/pokemon-trading-cards
- https://www.shuffled.gg/collections/pokemon/products.json?limit=250&page=1&country=GB

## Release steps

1. Merge after CI passes. Deploy Cloud to load JET's new bound and the sealed-pack filters.
2. Run **Qualify Shuffled Pokemon retailer** on main with Activate off (also runs without credentials on this PR). Inspect `shuffled-retailer-qualification` artifact for status `qualified`.
3. Run the same workflow with Activate on. It repeats fresh qualification and makes one transactional registry upsert using the existing readiness transitions. It refuses paused/rejected/already-monitored or suspended records, identity conflicts, incomplete catalogues, missing price/stock coverage, or mixed non-sealed products. The existing `FATEPRICE_PRODUCTION_DATABASE_URL` secret supplies the canonical database connection; no secret is available to the dry-run step.
4. Restart/redeploy Cloud after activation: runtime retailer selection currently happens at startup. Status `monitoring_enabled_restart_required` explicitly does not claim a successful scan.
5. Verify `/api/retailers` shows Shuffled configured, healthy and baseline completed, and JET healthy with a recent success. First baseline must not manufacture restock events. Subsequent real changes follow the existing lifecycle and publication policy.

No changes to stock thresholds, RRP authority, duplicate suppression, physical Echo policy, scan cadence or blocked-site handling. Shuffled is not granted official RRP authority. Other blocked retailers and the Pokemon Center stale catalogue still require independent recovery.

## Local validation

Full Signal Engine suite: 1,447 passed, zero failed, one skipped before the final JET-bound assertion; targeted coverage tests are rerun after it. Existing lifecycle transitions are tested for held states and invalid evidence. No production writes or notifications were issued by this development session.
