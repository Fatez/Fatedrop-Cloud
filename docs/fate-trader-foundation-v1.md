# Fate Trader Foundation Architecture v1

Status: foundation contract for implementation
Initial TCG: Pokémon
Principle: high precision, fail closed, evidence first

## Product boundaries

- Fate Trader: collector-to-collector trading ecosystem.
- Trade Binder: collection items explicitly made available to trade.
- Wants: structured collector demand.
- Trade Network: public browseable trading intentions.
- Fate Trade Finder: matching/search engine.
- Fate Trade Found: verified compatible-intention event.
- Fate Trade Hunt: persistent watch when no current qualifying match exists.

## Repository architecture

Fate Trader is not a standalone repository at v1.

Authoritative domain logic belongs in Fatedrop-Cloud and is consumed by:

- fatedrop-web for web UI/UX and server-facing integration;
- FateDrop-App for native mobile UI/UX and API consumption.

The web and app must not each implement independent matching or card identity rules.

## Canonical identity boundary

FateDrop uses one Card Identity Graph across Search, Collection, Wishlist, Fate Trader, Trade Finder and market intelligence.

Canonical printed identity:

TCG -> era/series -> set -> printing/card -> card number -> variant -> language

A physical owned copy is represented separately as a collection item.

Condition, grade, certification and photographs belong to the physical collection item and do not create a new canonical card identity.

Every verified canonical card receives an opaque stable fate_card_id.

Only VERIFIED identities may be selected by users. STAGED, CONFLICT, QUARANTINED and RETIRED identities are not eligible for new trade intent.

## Domain ownership

### Catalogue

Owns canonical card identity, aliases, provenance, source mappings and verification state.

### Collection

Owns physical copies held by a user, quantity, condition, grading and photos.

### Trader

Owns binder availability, wants, listings, matches and hunts.

### Trust

Owns reports, blocks, reputation evidence and moderation state.

### Value intelligence

Owns market observations and reference-value evidence. Trader may display evidence but must not classify a trade as good, bad, fair or unfair.

## Matching contract

A Fate Trade Found event may only be emitted after authoritative revalidation.

Pipeline:

1. Candidate retrieval.
2. Hard-constraint filtering.
3. Reciprocal-intent evaluation.
4. Evidence validation.
5. Match classification.
6. Authoritative state recheck.
7. Deduplicated event emission.

Initial classifications:

- EXACT_RECIPROCAL
- COMPATIBLE_RECIPROCAL
- ONE_WAY_OPPORTUNITY
- NO_MATCH

Only qualifying reciprocal classifications may generate FATE TRADE FOUND.

## Direct reciprocal MVP

For users A and B:

- A wants X;
- B offers X;
- B wants Y;
- A offers Y;
- all hard constraints pass.

This establishes compatible reciprocal intent.

It does not establish monetary fairness and does not force unspecified bundle composition.

## Trade Hunt contract

A Hunt stores a persistent structured intent and is evaluated incrementally when relevant network state changes.

Relevant events include:

- binder item published or changed;
- want created or changed;
- listing created, reactivated or withdrawn;
- collection item tradeability changed;
- event/local availability changed.

The system must not full-scan all users for every change.

## Fail-closed rules

Do not emit a match when any required fact is uncertain, including:

- unresolved card identity;
- unavailable quantity;
- incompatible language;
- incompatible condition/grade;
- withdrawn or stale listing;
- blocked relationship;
- trading-disabled account;
- missing required evidence.

Unknown remains unknown.

## MVP exclusions

No escrow, custody, held funds, integrated payments, cash adjustments, shipping labels, precise live location, multi-party graph trades or automated fairness judgements.

## Initial implementation order

1. Canonical card identity schema and provenance.
2. Collection item schema.
3. Trade Binder and Wants schema.
4. Trade Listing schema.
5. Exact reciprocal matching service.
6. Match fingerprint/deduplication.
7. Fate Trade Hunt event evaluation.
8. Read APIs for Trade Network, Finder and user trading state.
9. Web and mobile clients.
10. Trust/messaging beta gates.

No UI should become authoritative for trade state; clients submit intent and render server-verified results.
