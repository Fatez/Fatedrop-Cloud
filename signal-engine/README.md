# FateDrop Signal Engine V1

Shared UK Pokémon TCG catalogue + lifecycle signal service for FateDrop.

## Start locally

```bash
cp .env.example .env
npm install
npm test
npm run scan
npm run dev
```

The first successful retailer scan is a **quiet baseline**. It records the catalogue without emitting alerts. Later state changes create Whisper / Manifested / Vanished / Echo records.

For production use PostgreSQL and run `database/postgres.sql` first.

See `docs/ARCHITECTURE.md` for lifecycle rules, retailer scope, API contract and data-truth rules.
