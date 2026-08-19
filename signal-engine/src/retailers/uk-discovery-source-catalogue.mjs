import { DISCOVERY_SOURCE_TYPES } from "./discovery-sources.mjs";

// These sources are for candidate discovery only. Automation against any third-party
// directory requires a terms/robots review before enabling. Retailer stock/price
// monitoring must still use the retailer's own public or approved integration.
export const ukDiscoverySourceCatalogue = Object.freeze([
  {
    id: "cardcompass",
    name: "CardCompass",
    type: DISCOVERY_SOURCE_TYPES.PUBLIC_DIRECTORY,
    url: "https://cardcompass.co.uk/",
    coverage: ["pokemon", "magic", "yugioh", "lorcana", "one-piece", "flesh-and-blood", "digimon", "sports"],
    automation: "manual-review-required",
  },
  {
    id: "card-and-ink-shop-finder",
    name: "Card & Ink shop finder",
    type: DISCOVERY_SOURCE_TYPES.PUBLIC_DIRECTORY,
    url: "https://www.cardandink.com/pages/shop-finder",
    coverage: ["pokemon"],
    automation: "manual-review-required",
  },
  {
    id: "binder-builder-directory",
    name: "Binder-Builder UK TCG Shops",
    type: DISCOVERY_SOURCE_TYPES.PUBLIC_DIRECTORY,
    url: "https://www.binder-builder.co.uk/uk/tcg-shops",
    coverage: ["pokemon", "magic", "yugioh", "lorcana", "one-piece", "star-wars-unlimited"],
    automation: "manual-review-required",
  },
  {
    id: "uk-card-shows-vendors",
    name: "UK Card Shows vendor directory",
    type: DISCOVERY_SOURCE_TYPES.EVENT_DIRECTORY,
    url: "https://www.ukcardshows.co.uk/vendors",
    coverage: ["pokemon", "magic", "yugioh", "lorcana", "one-piece", "sports"],
    automation: "manual-review-required",
  },
]);

export function enabledDiscoverySources() {
  return ukDiscoverySourceCatalogue.filter((source) => source.automation === "enabled");
}
