# Fate Trader foundation status v1

## Completed in foundation slice

- Canonical product specification recorded.
- Dedicated Fate Trader foundation branch created.
- Shared architecture and domain contracts added.
- Existing FateDrop collector/backend reuse audited.
- Shared API versioning and error contract defined.
- Backend/web/mobile feature flag model defined.
- Canonical card identity schema added.
- Printed identity separated from physical copy condition/grade.
- Deterministic canonical card key and `fate_card_id` utility added.
- External source mappings and provenance model added.
- Conflict quarantine model added.
- Fail-closed identity tests added.
- Multi-variant upstream source mapping covered by tests.

## Not yet live

No production Fate Trader routes, tables, user data, matching, Hunts, notifications or UI are enabled by this branch.

## Next implementation dependency

1. Pokémon source adapter A -> staging candidate records.
2. Pokémon source adapter B -> corroborating staging records.
3. Reconciliation/conflict engine.
4. Verification promotion rules.
5. Read-only verified card/set catalogue API.

Only after this catalogue path is CI-green should Collection state be built on top of it.
