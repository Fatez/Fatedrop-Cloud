# FateDrop Market Reflection Policy

Status: locked product rule for Fate Collectors, Fair Price, FatePulse, True Price singles and future market intelligence.

## Core principle

**FateDrop reflects the market. FateDrop does not tell collectors what to do with their money.**

FateDrop may report factual, evidence-backed observations about current and historical TCG prices. It must not present those observations as financial advice, a recommendation to transact, or a prediction of future price direction.

## Consumer price language

### Known Price

Use `Known Price` when FateDrop has approved current market evidence but has not yet promoted the value through the calibrated Fair Price model.

Consumer payload should remain simple:

- amount
- currency
- as-of time when useful

Internal provider policy, source-quality scoring, evidence confidence and metric selection are not consumer-facing fields. They are eligibility controls deciding whether a price is allowed to appear.

If evidence is insufficient, use `Price unavailable` rather than exposing a weak-confidence badge.

### Fair Price

`Fair Price` is reserved for the future calibrated FateDrop valuation layer. Raw Cardmarket or other provider observations are inputs to Fair Price; they are not automatically Fair Price themselves.

Collectors should ultimately consume Fair Price when the model is ready. Until then, the public Collector contract may expose Known Price.

## Allowed market observations

Examples of acceptable factual language:

- price rising / price falling
- 7D / 30D movement
- heating up / cooling down when defined from observed market movement
- below Fair Price / above Fair Price
- below recent market range / above recent market range
- near a 30D low / high when directly calculated from history
- unusually large observed movement
- `£X cheaper/more expensive than 30 days ago`
- `X% below/above Fair Price`

These describe evidence already observed.

## Prohibited product language

Do not generate or encode consumer-facing claims such as:

- buy / sell signal
- strong buy / strong sell
- good time to buy
- exceptional opportunity
- recommended purchase
- expected to rise / fall
- likely to appreciate
- predicted return
- investment recommendation

A market can continue rising or falling after any observed state. FateDrop must not imply otherwise.

## Fate Collectors

Collectors may show:

- normal checklist completion
- missing cards
- Known/Fair Price of resolved exact cards
- Full Set Fair Value when complete pricing exists
- Owned Collection Fair Value
- Missing Card Fair Value
- 7D / 30D observed movement
- cheapest / most expensive missing cards
- price-falling missing cards based on historical movement

Collectors must not convert those facts into a recommendation to complete a set or purchase a card.

Example:

Allowed: `Your 12 missing cards are £17.40 cheaper than 30 days ago.`

Not allowed: `Now is a good time to complete this set.`

## True Price / FateMatch

For a single listed at £34.99 against a Fair Price of £42.80, FateDrop may state:

`£7.81 below Fair Price · 18.25% below`

It must not append `Strong buy`, `Good opportunity`, or equivalent advice.

## Internal intelligence

Internal evidence quality / confidence may still be used to decide:

- whether a price is eligible for display;
- whether a canonical identity is sufficiently resolved;
- whether evidence is fresh enough;
- whether a derived market observation is supportable.

That internal confidence is not itself a consumer feature. If the evidence does not clear the required threshold, fail closed or report the factual field as unavailable.
