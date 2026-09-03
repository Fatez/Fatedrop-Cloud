# Fate Price — Source Permission Policy

Reviewed: 2026-09-03

This is an engineering source-governance record, not legal advice. FateDrop must re-review provider terms if a source, acquisition method or intended use changes.

## Rule

A pricing source is not allowed merely because its data is publicly visible.

Before ingestion, FateDrop must identify:

1. the provider;
2. the exact acquisition mode (public download, API, website, partner feed, etc.);
3. whether the intended FateDrop use is permitted for that mode;
4. attribution/redistribution requirements;
5. freshness and technical limits.

Unreviewed, blocked or approval-required sources fail closed.

The executable registry is `src/trader/value/provider-policy.mjs`.

## Approved V1 source

### Cardmarket public downloadable data

Status: **APPROVED for the public-download route only.**

Official Cardmarket statements reviewed:

- 2024 State of Cardmarket: Cardmarket announced the product catalogue and price-guide data would be publicly available and specifically gave examples including fetching prices for an app/site and collection tracking/matching without API approval.
- 5 June 2024 announcement: Cardmarket made price guides and product catalogues downloadable for all games.
- 2025 Cardmarket/Scryfall announcement: Cardmarket states its complete product catalogue and all price parameters are public, updated daily, and may be imported/incorporated into applications with no extra permission/access point.

Official reference pages:

- https://www.cardmarket.com/en/Insight/Articles/the-state-of-cardmarket-2024
- https://news.cardmarket.com/en/Magic/were-making-the-price-guide-and-product-catalogue-available-for-download
- https://www.cardmarket.com/en/Insight/Articles/scryfall-x-cardmarket
- https://www.cardmarket.com/en/Magic/Data/Price-Guide

Cardmarket's current Price Guide page lists Pokémon, One Piece and Lorcana among the downloadable games.

Engineering restrictions:

- Fetch only official Cardmarket public download artifacts from `downloads.s3.cardmarket.com`.
- Do not scrape Cardmarket HTML for price ingestion.
- Do not substitute the authenticated/restricted Cardmarket API under this approval.
- Preserve source name, source snapshot/effective time and native currency.
- Map external product IDs to verified FateDrop canonical card identities; unresolved mappings fail closed.
- Re-review this permission record if Cardmarket changes the public-download terms or distribution model.

## Blocked without written permission

### Pokémon Wizard website/pricing data

Status: **BLOCKED as an ingestion source.**

Pokémon Wizard's current Terms prohibit scraping/crawling/systematic extraction without prior written consent and prohibit reproduction/redistribution/resale of pricing data.

Reference:

- https://www.pokemonwizard.com/terms

Allowed current use: manual product/UX benchmarking and comparison of independently calculated FateDrop outputs. Do not copy, scrape, persist or redistribute Pokémon Wizard pricing data.

## Approval required

### TCGplayer API / TCGplayer pricing

Status: **APPROVAL REQUIRED; not V1 ingestion.**

TCGplayer's API terms restrict combining pricing data with third-party pricing, rebranding TCG content, commercial/competitive redistribution and automated extraction outside approved API access. Do not ingest into the canonical Fate Price layer unless the intended use is separately reviewed and authorised.

Reference:

- https://help.tcgplayer.com/hc/en-us/articles/360061115874-TCGplayer-API-Terms-Conditions

### Cardmarket authenticated API

Status: **APPROVAL REQUIRED; not the approved V1 route.**

Cardmarket's old price-guide API is restricted/deprecated. FateDrop's V1 approval applies only to the separate public downloadable datasets.

## Product boundary

FateDrop may calculate its own derived outputs from approved evidence, including:

- Fate Price per canonical card;
- Full Set Value;
- Owned Collection Value;
- Missing Card Value;
- historical 7D/30D movement once sufficient snapshots exist;
- coverage/freshness/confidence indicators.

Derived values must retain enough provenance internally to identify the underlying approved source and must never imply that Pokémon Wizard, Cardmarket or another provider endorses FateDrop unless an agreement explicitly says so.
