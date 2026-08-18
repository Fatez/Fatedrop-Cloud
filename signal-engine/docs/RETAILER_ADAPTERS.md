# Retailer adapters — V1

## General rule

Adapters observe public catalogue/product pages only. FateDrop uses a normal identifiable user agent, conservative polling, conditional requests where supported, and stops on 401/403/429 rather than attempting to bypass access controls, CAPTCHAs or retailer rate limits.

## Pokémon Center UK

Discovery root: `https://www.pokemoncenter.com/en-gb/search/tcg-cards`

Product URLs: `/en-gb/product/...`

Role in V1:
- product/SKU discovery
- official listed price used as an RRP reference when canonical product matching succeeds
- stock phrase classification such as sold-out vs purchasable state

## Smyths Toys UK

Discovery root: `https://www.smythstoys.com/uk/en-gb/toys/action-figures-and-playsets/pokemon/pokemon-trading-card-game/c/SM0601011202`

Product IDs come from `/p/<ref>` URLs.

Role in V1:
- major-retailer catalogue discovery
- price and online availability evidence where present in server-rendered catalogue/product markup

## Chaos Cards

V1 scans sealed-product subcategories rather than the enormous singles catalogue:
- booster boxes
- booster packs
- collection boxes
- elite trainer boxes
- gift tins
- Japanese products
- other sealed products
- theme decks

Product URLs use `/prod/...`.

Role in V1:
- specialist-retailer catalogue discovery
- price
- stock states such as Add to basket / Only N left / Coming soon / Notify me

## Why adapters are configurable

Retailers change markup. Extraction first looks for structured Product JSON-LD and then falls back to card semantics. Retailer selectors/URL patterns are kept in `src/config/retailers.mjs` so a markup change can be repaired without rewriting the lifecycle engine.
