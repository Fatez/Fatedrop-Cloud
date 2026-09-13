# Section B Cardmarket recovery — 2026-09-13

## Scope

Recover exact Cardmarket mappings for the 1,222 English pricing-eligible Section B identities that currently have no Cardmarket mapping. Existing Section A mappings are intentionally untouched.

## Primary read-only rehearsal

Pinned TCGdex revision: `5b6a2859f454972477a9953ffe5cb554d24c45e9`

Cardmarket catalogue SHA-256: `a5a4cb310b38580e64160dd5fb330706ab259777522f5acf0cdeac5d8b887f52`

Cardmarket price-guide SHA-256: `ed9a59af5f73eaaedfcb7a27c2d0ba4960363ea7c07635946d349cb925ecbb3c`

Result:

- 1,222 Section B identities audited
- 470 conflict-free exact mappings passed every primary gate
- 752 held
- 560 of the holds lacked a root Cardmarket product ID and were sent to the secondary pass

## Relaxed secondary read-only rehearsal

The secondary pass remains fail-closed and uses only the approved official Cardmarket catalogue/price-guide downloads. It does not scrape Cardmarket and does not depend on the private API.

Relaxations are discovery-only:

- punctuation/diacritic normalization
- gender and LV.X normalization
- exact named parent-set scope for Gallery/Classic subsets
- dominant whole-set signature as a set-scope proof when sufficiently strong
- exact attack/ability descriptor matching for duplicate product names

The canonical FateDrop finish remains locked and selects the Cardmarket Normal/Holo price lane. Ownership conflicts, missing price lanes, ambiguous products and unsupported prices remain held.

Result:

- 560 primary no-root holds audited
- 27 additional conflict-free mappings passed every secondary gate
- 533 remained held
- no batch source collisions among the 27

## Activation gate

The activation combines exactly 470 + 27 = 497 candidates and aborts unless all pinned counts and both Cardmarket source hashes still match the rehearsal. The combined writer performs one transactional ownership-checked mapping write. Price persistence remains delegated to the existing guarded Cardmarket production cycle.

No canonical card rows are deleted. No finish is inferred. No missing provider value becomes £0. Ambiguous cases stay unpriced.
