# Fate Trader — FateTrust & Safe Exchange v1

## Purpose

FateTrust is an evidence-backed confidence layer for Fate Trade Finder. It must never create a trade match and must never override canonical card identity, reciprocal compatibility, quantity, copy/condition constraints, or exchange-method compatibility.

The matching order is:

1. Canonical card truth.
2. Reciprocal/compatible trade intent.
3. Hard compatibility gates.
4. Finder opportunity classification.
5. FateTrust / exchange-confidence ranking of already-valid opportunities.

A high FateTrust score cannot turn `NO MATCH` into `FATE TRADE FOUND`.

## FateTrust v1 evidence model

The scorer is bounded to 0–1000 and uses verified behaviour rather than popularity.

Weighted components:

- successful verified history: 30%
- verification strength: 20%
- account integrity: 15%
- counterparty diversity: 15%
- verified trade-value experience: 10%
- verified post-trade feedback: 10%

Effective verified trade evidence uses diminishing evidence strength:

- partner Hub exchange: 1.00
- tracked postal exchange: 0.75
- dual-confirmed exchange: 0.40

Evidence confidence and a dynamic score ceiling prevent a tiny perfect history from reaching an elite score. Confirmed fraud is an account restriction signal independent of the numeric score.

Unsubstantiated reports are not a scoring input. Only substantiated outcomes may create penalties.

Linked social profiles are not required and are not a core trust input.

## Exchange Confidence

FateTrust describes historical evidence about an account. Exchange Confidence describes risk evidence for one proposed trade.

Exchange Confidence can consider:

- FateTrust evidence strength;
- proposed transaction value versus verified historical value;
- largest previously verified trade;
- Hub versus postal exchange method;
- whether a Hub route is available.

The same user may therefore have strong FateTrust but only moderate Exchange Confidence for a transaction far larger than their verified history.

## Safe Exchange v1

A Safe Exchange is an atomic two-sided agreement. Each side's commitment records canonical FateDrop card IDs and an optional GBP cash adjustment.

The system does not ask a partner retailer to value, grade, or authenticate cards by default. A Fate Hub proves the exchange environment / handoff evidence only. Any separate authentication service is outside this protocol unless explicitly contracted later.

### Hub route

`DRAFT → AGREED → CHECKED_IN → INSPECTED → CONFIRMING → COMPLETED`

Requirements:

- both parties explicitly agree to the atomic terms;
- Hub check-in uses a short-lived, transaction-bound proof;
- permanent/static Hub QR codes are rejected by protocol design;
- both parties check in;
- both parties inspect the physical assets;
- both parties independently confirm completion;
- either side can cancel before completion.

### Postal route

`DRAFT → AGREED → IN_TRANSIT → INSPECTED → CONFIRMING → COMPLETED`

Postal exchange requires tracking from both sides before dispatch is considered recorded. Production policy may gate postal trading by FateTrust / Exchange Confidence; that policy is intentionally separate from the protocol state machine.

## Current implementation boundary

This foundation adds deterministic domain logic and tests only. It does not yet persist trust history, issue Hub sessions, expose public trust data, alter Finder ranking, or activate Safe Exchange in production.

Those integrations must be added behind Cloud-owned contracts. App and Web should consume the resulting public projections rather than calculate independent trust scores.
