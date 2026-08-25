# Fate Trade Finder compatibility contract

Fate Trade Finder measures **stated trading-intent compatibility**. It does not judge whether a trade is financially fair, equal value, profitable or advisable.

## Opportunity classes

### `FATE TRADE FOUND`

This is the highest-confidence event and is deliberately difficult to earn.

It requires:

- collector A wants the exact card collector B is actively offering
- collector B has an exact active Want satisfied by an active card collector A is offering
- both card copies satisfy the stated raw / graded constraints
- both sides share at least one enabled trade method
- required quantities are available
- the offer is still visible, active and effectively available

Acceptable-card pools, open-to-offers behavior, partial quantities and subjective similarity can never be promoted to `FATE TRADE FOUND`.

### `STRONG POTENTIAL MATCH`

A high-scoring opportunity where negotiation looks meaningfully plausible, but strict reciprocal exactness is not proven. Examples include:

- the candidate has the exact wanted card and is open / negotiable
- the candidate has the exact wanted card and their acceptable-card pool overlaps the seeker's active trade table
- both exact Wants align but the available quantity only partially satisfies the request
- an acceptable alternative target plus strong reciprocal evidence

### `POTENTIAL TRADER`

A lower-confidence but still useful card-show connection. The person has an exact or explicitly acceptable card, copy/method constraints are compatible, and their stated trade mode leaves a plausible negotiation route.

## Hard gates

Hard gates reject an opportunity rather than subtracting points:

- self match
- target Want inactive
- offered card outside the exact Want and acceptable-card pool
- offer not active, network-visible or effectively available
- raw condition below the requested minimum
- raw / graded mismatch
- grade outside range
- grading company not accepted
- no common local/postal method
- `exact_wants_only` offer without an exact reciprocal Want

## Score

The compatibility score is 0–100:

| Evidence | Max |
| --- | ---: |
| Desired-card overlap | 40 |
| Reciprocal Want / trade-table overlap | 25 |
| Raw / graded compatibility | 15 |
| Shared trade method | 10 |
| Trade flexibility | 5 |
| Listing freshness | 5 |

Current thresholds:

- `>= 70` → Strong Potential Match
- `>= 50` → Potential Trader
- below 50 → not surfaced by Finder

Exact reciprocal matches bypass the threshold label and become `FATE TRADE FOUND` only when all exact-event requirements are satisfied.

### Desired-card scoring

- exact primary target, sufficient quantity: 40
- exact primary target, partial quantity: 32
- explicitly acceptable alternative, sufficient quantity: 32
- explicitly acceptable alternative, partial quantity: 26

### Reciprocal scoring

- candidate's exact primary Want is satisfied by the seeker's active trade table: 25
- candidate's explicitly acceptable-card pool is satisfied: 18
- no stated reciprocal overlap: 0

Open / negotiable / bundle-friendly offers can still become potential matches without reciprocal evidence, because this models the real card-show behavior of approaching a table and starting a conversation.

## Safety / truth rules

- Never use price or estimated card value in the compatibility score.
- Never label a potential opportunity as a fair trade.
- Never create `FATE TRADE FOUND` from acceptable-card-pool overlap alone.
- Revalidate listing availability, Wants, quantities and constraints immediately before creating or delivering an exact event.
- Use deterministic opportunity fingerprints for deduplication.
- Matching remains behind `FATE_TRADER_MATCHING_ENABLED`; public delivery must remain dark until Trade Network listings are authoritative.
