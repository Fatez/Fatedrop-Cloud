# Cardmarket immutable-observation repair

Production read-only audit and isolated branch rehearsal on 2026-09-15.

## Proven cause

The six-owner correction moved 27 historical observations to the correct identities and mapping rows without recomputing `content_fingerprint`. That fingerprint includes both ownership fields. Reconstructing each observation with its former owner and mapping reproduces its stored fingerprint exactly: 27/27. No price, raw source evidence, finish, or observation ID needs changing.

The current daily source artifact SHA256 is `5acedfc9bda0b7b59b1cab4538135941e55d3cb34381a38ec5d3b1f8841d43ca`, snapshot `pokemon-price-guide-v1-2026-09-15T00:48:12.000Z`. The daily batch accepts 18,233 observations: 18,227 already exist, six would be new. Exactly six existing observations conflict. Each incoming payload equals the reconstructed stored payload; only the stored fingerprint is stale.

The frozen 27-row manifest retains the original evidence and fingerprints. Repair digest: `0e426b779c7c6d1055aaca9de92771f840763c2e386e2870aedc3049d4228897`.

## Independent schema issue

Production lacks `fatedrop_product_market_memory` and `fatedrop_product_market_observations`. Both are defined by the existing `database/canonical-market-memory.sql`. Its application succeeded on isolated branch `br-flat-heart-axwjz6ty`. These are product-market classification tables, separate from card price history.

## Verification and release

- The fingerprint repair succeeded transactionally on the isolated branch, then ROLLBACK restored all 27 original fingerprints. Observation count remained 98,399.
- Complete local Signal Engine suite: 1,542 passed, zero failed, one skipped (1,543 total).
- Production has not been changed by this repair.
- The PR workflow runs the full suite, then rehearses schema creation, fingerprint correction and the real daily ingestion in one SERIALIZABLE transaction with ROLLBACK. Its artifact is required before activation.
- Activation is manual, requires explicit approval plus exact manifest and price-guide hashes, and aborts on any full-row or mapping drift.
- The broader 595 insufficient-proof identities, 1,079 collision rows and 22 source ownership conflicts are outside this checksum repair. This does not claim activation of the entire read-only recertification result.
