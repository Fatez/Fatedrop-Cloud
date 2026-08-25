# Fate Trader v1 — Existing FateDrop Reuse Audit

## Decision

Fate Trader remains in `Fatedrop-Cloud` as a shared authoritative domain consumed by the website and native app. No separate Fate Trader repository is required for v1.

## Reusable foundations

### PostgreSQL / Neon conventions
The signal engine already uses PostgreSQL with text primary keys, explicit evidence/provenance tables, JSONB evidence payloads and indexed read paths. Fate Trader should follow these operational conventions rather than introduce a second persistence stack.

### Canonical identity philosophy
`signal-engine/database/canonical-product-identity.sql` already establishes the correct FateDrop pattern for external identifiers and evidence:

- FateDrop owns the canonical identity.
- External identifiers map to it.
- Evidence retains source, URL and timestamps.
- Conflicts are represented instead of guessed through.

Fate Trader reuses this philosophy, not the sealed-product identity tables themselves.

### API/runtime
The signal engine is Node >=22, ESM and uses the built-in Node test runner. Trader domain utilities should use the same runtime and dependency-light approach initially.

### Notification/event philosophy
Existing FateDrop notification and signal infrastructure is suitable for the later `FATE TRADE FOUND` domain event, but Trader must emit only after authoritative match revalidation.

### Fate Encounters
Existing Fate Encounters infrastructure can later provide event identifiers/venues for opt-in event trading. It is not required for Trader MVP matching.

## Explicit non-reuse boundaries

### Sealed product identity != card identity
`fatedrop_products` / `fatedrop_product_identities` describe retail products such as boxes and sealed products. Individual collectible cards require a separate canonical graph.

No Trade Binder item should reference a sealed-product identity as a substitute for a card printing.

### Retail offer price != card market value
Retail-offer/RRP evidence is not a defensible substitute for collectible-card market evidence. Trader value intelligence will receive its own market-observation domain later.

### Condition/grade != printed card identity
Condition, grader, grade, certification number and photographs describe a user's physical copy. They must not change `fate_card_id`.

## Canonical card graph implemented in first slice

`TCG -> series/era -> set -> printing/card number -> variant -> language`

Implemented tables:

- `fatedrop_tcgs`
- `fatedrop_card_series`
- `fatedrop_card_sets`
- `fatedrop_card_printings`
- `fatedrop_card_identities`
- `fatedrop_card_source_mappings`
- `fatedrop_card_provenance`
- `fatedrop_card_identity_conflicts`

## Identity rules

1. An adapter must explicitly provide TCG, series, set, collector number, printing discriminator, variant and language.
2. The shared identity layer never silently defaults a missing variant or language.
3. Canonical key generation is deterministic.
4. `fate_card_id` is derived from the canonical key and does not depend on upstream source IDs.
5. Different upstream sources describing the same exact printing converge on one FateDrop ID.
6. Conflicting upstream records are quarantined for resolution.
7. Only verified identities should later be exposed as selectable Trader catalogue identities.

## Next dependency

Build the first Pokémon catalogue source adapter into a staging pipeline, then reconcile at least two sources before promoting records to `verified`.

The adapter must map source-specific concepts into explicit FateDrop fields rather than allowing the core identity layer to infer them.
