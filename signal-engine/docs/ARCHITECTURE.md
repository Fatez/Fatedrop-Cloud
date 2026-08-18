# FateDrop Signal Engine V1

## Purpose

One shared intelligence engine supplies the website, mobile app and Discord. User interfaces do not scrape retailers and do not invent lifecycle states.

`Retailer catalogues -> observations -> canonical products/offers -> lifecycle engine -> signals API -> web/mobile/Discord`

## V1 retailer scope

- Pokémon Center UK — official catalogue and RRP reference where the same canonical product is matched.
- Smyths Toys UK — Pokémon TCG catalogue.
- Chaos Cards — Pokémon sealed catalogue; singles/code cards are deliberately excluded in V1 to avoid noisy high-volume signals.
- Indie stores are intentionally deferred. New sources use the same retailer adapter contract.

The scanners only request public catalogue pages, use conservative delays, honour 429 responses, and stop on 401/403 instead of bypassing access controls or anti-bot challenges.

## Lifecycle rules

The first successful scan is a quiet baseline. Existing products are stored but do not generate thousands of launch alerts.

- **Whisper** — a new catalogue product or pre-release status appears before verified purchasability.
- **Manifested** — an offer becomes verified purchasable for the first time.
- **Vanished** — a previously purchasable offer is no longer verified available.
- **Echo** — a product with prior verified availability returns.

Every signal retains the underlying observation evidence, timestamps, price and status transition.

## Canonical product identity

V1 uses deterministic title normalisation + product type. Retailer SKUs remain separate. Pokémon Center price can become the official RRP reference when the canonical key matches. V2 can add GTIN/EAN matching and fuzzy/manual reconciliation.

## Price truth

`pricePence` is the retailer's observed listed price. `postagePence` remains null until a retailer-specific delivery rule is evidence-backed. FateDrop must not call a price “delivered” if postage is unknown.

## API

- `GET /health`
- `GET /v1/network`
- `GET /v1/retailers`
- `GET /v1/signals?state=manifested,echo&retailer=chaos-cards&since=<unix>&limit=100`
- `POST /internal/scan` with `X-Fatedrop-Secret`

Read endpoints use `Authorization: Bearer <FATEDROP_SIGNAL_API_TOKEN>` when configured.

## Production storage

Run `database/postgres.sql` and set:

```
FATEDROP_SIGNAL_STORE=postgres
DATABASE_URL=...
```

Local development defaults to an ignored JSON file.
