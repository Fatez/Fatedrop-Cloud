# Retailer Pressure Intelligence v1

Retailer Pressure is an internal FateDrop intelligence layer that measures how strongly a retailer appears to be preparing for a drop or restock.

It is **not** a stock state and is deliberately excluded from lifecycle eligibility. A high pressure score cannot create `MANIFESTED`, cannot make an unverified purchase path purchasable, and cannot independently create `ECHO`.

## Inputs

Pressure is derived only from observable retailer evidence already accepted by the signal engine, including:

- structured catalogue/SKU exposure
- official product-page or catalogue exposure
- placeholder-to-commercial price transitions
- inventory and launch metadata
- retailer backend exposure
- queue, network and security readiness
- preparation clusters
- stock/quantity transitions
- repeated observation age thresholds
- simultaneous appearance of multiple meaningful evidence kinds

Previous pressure can provide short-lived inertia and decays as retailer behaviour cools. This gives the engine temporal memory without turning stale observations into current truth.

## Output

Each reading contains:

- `score` (0-100)
- `band`: `quiet`, `watch`, `elevated`, `high`, `critical`
- pressure delta versus the previous observation
- attention mode: `passive`, `standard`, `elevated`, `burst`
- an advisory scan-cadence hint (never below 60 seconds)
- a compact behavioural fingerprint
- weighted, explainable pressure drivers

The scan-cadence value is a **hint only** in v1. It is not automatically applied by the scanner, so introducing this intelligence cannot unexpectedly increase retailer traffic.

## Truth boundary

FateDrop's canonical lifecycle remains unchanged:

`WHISPER -> ECHO -> MANIFESTED -> VANISHED`

`UNKNOWN` remains unknown. Retailer Pressure predicts attention-worthiness, not stock. Purchase verification and existing lifecycle gates remain authoritative.
