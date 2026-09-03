# Fate Value — Pokemon Wizard reference policy

Status: internal research only
Reviewed: 2026-09-03

## Purpose

Pokemon Wizard may be used as a small-sample manual reference when validating Fate Value research. It is an independent sense-check only. It does not define Fate Fair Value and it is not a canonical identity source.

## Legal / source boundary

Pokemon Wizard's Terms of Service, last updated 2026-04-29, prohibit scraping, crawling, systematic extraction, disruptive automated tools, and reproduction/redistribution/resale of pricing data without prior written consent.

Until FateDrop receives explicit written permission, API access, or a licence that changes this boundary:

- no automated fetching from pokemonwizard.com;
- no scraping, crawling, browser automation, bulk extraction or endpoint discovery;
- no scheduler or background ingestion;
- no persistence of Pokemon Wizard prices into the FateDrop market-history ledger;
- no redistribution or public display of Pokemon Wizard pricing as FateDrop data;
- no use of Pokemon Wizard as canonical card identity authority;
- no inferred FX conversion to make USD values directly comparable with Cardmarket EUR values.

## Allowed internal workflow

A human may inspect a small number of Pokemon Wizard card pages and manually enter a reference price into the transient validation helper for an already verified FateDrop card identity.

The helper is intentionally marked:

- `acquisitionMode: manual-reference`
- `automatedAcquisitionAuthorized: false`
- `persistenceAuthorized: false`
- `redistributionAuthorized: false`
- `bulkExtractionAuthorized: false`

Same-currency comparisons may be calculated transiently. Cross-currency comparisons fail closed with `currency_mismatch_fx_required` until FateDrop has an explicit FX policy.

## Source role

Current intended research stack:

1. Cardmarket public catalogue/price-guide data — structured European market evidence.
2. Pokemon Wizard — manual independent validation/reference only.
3. Authorised realised-sale evidence (for example an official eBay data route) — future transaction evidence.
4. FateDrop's own historical observations — long-term internal market history.

Fate Value must remain FateDrop-derived intelligence over lawful evidence rather than a republished third-party price feed.

## Promotion gate

Any future automated Pokemon Wizard integration requires a new review and explicit evidence of permission before code is allowed to fetch, persist, schedule, or redistribute Pokemon Wizard data.
