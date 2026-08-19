# FateDrop UK Retailer Intelligence Network v1

## Purpose

Build a scalable UK TCG retail intelligence layer covering national retailers, specialist online retailers, regional stores and independents without hard-coding a unique product model for each store.

## Collector truth

FateDrop should expose evidence, not retailer rankings.

For each comparable offer the network should preserve, when known:

- canonical product identity
- retailer identity
- item price
- stock state
- official/reference RRP and provenance
- mandatory delivery/fees
- True Price (delivered total)
- item £ / % difference from RRP
- delivered £ / % difference from RRP
- observation timestamp and freshness

Unknown delivery must remain unknown. A cheap item with unknown or expensive postage must never be treated as the cheapest delivered purchase by assumption.

Selling above RRP is not itself a trust failure. FateDrop reports it transparently and allows objective sorting/filtering.

## Retailer classes

1. National — high-volume national chains / major first-party retail.
2. Specialist — established TCG/card retailers with significant online catalogues.
3. Regional — multi-location or regionally significant stores.
4. Independent — small/local retailers, including single-store and online-first businesses.
5. Event vendor — temporary/event-scoped sellers; later phase.

## Registry lifecycle

CANDIDATE -> QUALIFYING -> READY -> MONITORED

PAUSED and REJECTED are operational states, not public trust labels.

Candidate discovery never implies partnership, verification or catalogue accuracy.

## Adapter strategy

Prefer the least fragile lawful source available:

1. Structured retailer/feed integration
2. Shopify adapter
3. WooCommerce adapter
4. CSV/feed onboarding
5. Generic public catalogue HTML
6. Browser collector where ordinary public catalogue navigation genuinely requires it

Never bypass access controls or challenge mechanisms. If a retailer blocks automated catalogue access, FateDrop should pause that adapter and prefer an approved feed/retailer integration.

## Onboarding gates

Before enabling production monitoring for a retailer:

- identify business/site and catalogue entrypoint
- classify platform/adapter
- dry-run catalogue
- validate product and stock mapping
- capture delivery policy evidence where possible
- attach RRP provenance strategy
- establish expected catalogue-size/freshness bounds
- enable health monitoring

Retailer verification is separate from technical monitor readiness.

## Safety invariants

- incomplete scans never replace the last complete state
- suspicious catalogue collapse is rejected pending revalidation
- unknown delivery is never free
- unknown RRP is never inferred from retailer price
- paid status cannot buy better trust or organic price ranking
- public badges must have objective evidence
- collector UI may sort by delivered cost, availability, distance or other explicit evidence

## Scale architecture

Retailer discovery -> registry -> adapter -> raw observations -> canonical product matching -> RRP provenance -> offer/stock state -> True Price -> signals -> Search/FateFind/alerts/app/website/Discord.

The registry is designed so adding another retailer becomes mostly configuration/evidence + adapter selection rather than a new product model.

## Current v1 scope

Implemented foundation:

- retailer class/state/verification/adapter vocabulary
- normalized candidate model
- qualification/onboarding planning
- platform adapter inference
- monitoring cadence policy
- incomplete catalogue replacement guard
- evidence-safe RRP/True Price calculations
- objective delivered-price sorting
- market summary including above-RRP counts/premiums
- compatibility metadata for Pokémon Center UK, Smyths UK and Chaos Cards
- automated Signal Engine tests in CI

Not yet claimed complete:

- exhaustive UK retailer discovery dataset
- Shopify/WooCommerce production adapters
- retailer registry persistence in Postgres
- production discovery crawler
- automated delivery-policy extraction
- full canonical product matching across every retailer
- live multi-TCG expansion beyond configured sources
