# FateDrop UK Retailer Intelligence Network v1

## Purpose

Build a scalable UK TCG retail intelligence layer covering national retailers, specialist online retailers, regional stores and independents without hard-coding a unique product model for each store.

## Collector truth

FateDrop exposes evidence, not subjective retailer rankings.

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

Unknown delivery remains unknown. A cheap item with unknown or expensive postage must never be treated as the cheapest delivered purchase by assumption.

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

The lifecycle is enforced. A retailer cannot jump straight from discovery to monitoring. READY/MONITORED require adapter qualification, a successful dry run, catalogue-completeness evidence and validated stock mapping. MONITORED additionally requires explicit approval.

Retailer verification is a separate axis. Technical monitoring success never creates a Verified badge.

## Discovery model

Discovery sources identify candidate businesses only. They do not provide stock, price, delivery, partnership or verification truth.

Current source classes:

- public directories
- public search/research
- event/vendor directories
- retailer submissions
- manual retailer-site research

Third-party directory automation is disabled until each source has an explicit terms/robots review. Current source catalogue includes CardCompass, Card & Ink's shop finder, Binder-Builder's UK TCG directory and UK Card Shows' vendor directory as candidate-discovery references only.

Candidates are deduplicated by retailer hostname and discovery evidence is merged. Coverage reporting distinguishes discovered candidates from actual monitored retailers.

## Adapter strategy

Prefer the least fragile lawful source available:

1. approved structured retailer/feed integration
2. approved Shopify structured catalogue
3. approved WooCommerce Store API catalogue
4. retailer-provided CSV/feed onboarding
5. qualified public catalogue HTML
6. browser collector only where ordinary public catalogue navigation genuinely requires it

Never bypass access controls or challenge mechanisms. If a retailer blocks automated catalogue access, FateDrop pauses/backoffs rather than attempting to defeat the control.

Structured Shopify/Woo feeds must be explicitly recorded and approved. The engine does not probe hidden API endpoints.

Generic HTML monitoring requires explicit catalogue URLs plus product/SKU extraction patterns established during qualification.

## Qualification loop

The intended operator workflow is:

DISCOVER -> DEDUPE -> INSPECT -> QUALIFY -> CONFIGURE ADAPTER -> DRY RUN -> REVIEW -> READY -> EXPLICIT APPROVAL -> MONITORED

The safe homepage inspector may detect public Shopify/Woo markers and suggest catalogue/delivery-policy links on the retailer's own website. It does not infer feed approval or enable monitoring.

Dry runs execute the configured adapter without writing products, offers, signals, health state or retailer lifecycle state. Diagnostics include:

- products observed
- pages/feed requests scanned
- price coverage
- stock-state coverage
- expected catalogue minimum / collapse checks
- sample normalized products
- adapter and stock-mapping readiness evidence

## Runtime registry

The additive Postgres registry schema stores retailer identity, lifecycle state, verification state, catalogue configuration, delivery evidence, monitoring policy, discovery evidence and monitor-run diagnostics.

Dynamic registry runtime is behind:

`FATEDROP_RETAILER_REGISTRY_ENABLED=false`

It is OFF by default. With the flag off, the existing static retailer configuration remains the production-safe path. When deliberately enabled after the migration is applied, only MONITORED registry rows are compiled into scanner configs. Unsupported or incomplete adapter configs fail closed.

Registry runtime v1 deliberately supports one active TCG per monitored retailer config while the wider canonical multi-TCG model is developed.

## Price intelligence

The v1 price layer supports:

- item price vs RRP £/%
- delivered price vs RRP £/% when mandatory delivery is known
- above-RRP offer counts and highest observed premium
- objective delivered-cost sorting with known delivery first
- null/unknown handling when delivery or RRP evidence is missing

Paid retailer status cannot alter organic True Price ordering or buy trust.

## Safety invariants

- incomplete scans never replace the last complete state
- suspicious catalogue collapse is rejected pending revalidation
- unknown delivery is never free
- unknown RRP is never inferred from an ordinary retailer selling price
- paid status cannot buy better trust or organic price ranking
- public badges require objective evidence
- discovery never implies partnership or monitoring
- third-party directories are not stock/price evidence
- structured feeds require explicit approval
- unsupported registry adapters fail closed

## Operator commands

From `signal-engine`:

- `npm run retailers:queue` — inspect the current source-backed qualification queue and blockers.
- `npm run retailers:inspect -- --retailer=<seed-id>` — inspect one seeded retailer's own public site.
- `npm run retailers:inspect -- --url=https://shop.example --name="Shop"` — inspect an ad-hoc candidate without persistence.
- `npm run retailers:seed` — deliberately persist the current seed candidates to Postgres. This requires `DATABASE_URL`; it is never run automatically.

## Current v1 implementation

Implemented:

- retailer class/state/verification/adapter vocabulary
- normalized retailer registry model
- source policy and candidate intake
- hostname deduplication/evidence merging
- initial source-backed UK candidate queue
- internal qualification work queue
- safe public-site platform/catalogue/delivery inspector
- Candidate -> Qualifying -> Ready -> Monitored transition enforcement
- monitoring cadence policy
- Shopify and WooCommerce structured normalisers
- approved structured-feed network adapter
- qualified generic HTML adapter path
- no-write adapter dry-run diagnostics
- dynamic Postgres registry runtime behind an OFF-by-default feature flag
- additive Postgres retailer/discovery/monitor-run schema and repository
- evidence-backed postage preservation
- incomplete catalogue replacement guard
- evidence-safe RRP/True Price calculations
- objective delivered-price sorting
- market summary including above-RRP counts/premiums
- compatibility with existing Pokémon Center UK, Smyths UK and Chaos Cards static configs
- automated Signal Engine tests in GitHub Actions

Still deliberately incomplete:

- exhaustive UK retailer discovery dataset
- approved automation for any third-party directory source
- automatic delivery-policy extraction and rule interpretation
- automatic promotion of qualified candidates to MONITORED
- complete canonical matching for ambiguous bundles/variants across every retailer
- production application of the retailer-registry migration
- live multi-TCG runtime expansion beyond the current single-active-TCG registry constraint
