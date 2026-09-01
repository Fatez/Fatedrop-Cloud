import { ADAPTER_TYPES, RETAILER_CLASSES, RRP_AUTHORITY, VERIFICATION_STATES } from "./registry.mjs";

const SEALED_POKEMON = /pokemon.*(?:tcg|trading card|booster|elite trainer|collection|tin\b|blister|deck\b|battle academy)|(?:tcg|trading card).*pokemon/i;

// These configs override an already-monitored registry row at runtime. They do
// not promote a candidate or write registry state; the registry remains the
// authority for whether the retailer is monitored.
export const monitorRecoveryOverrides = Object.freeze([
  Object.freeze({
    id: "john-lewis-uk",
    name: "John Lewis & Partners",
    tcg: "pokemon",
    tcgs: ["pokemon"],
    retailerClass: RETAILER_CLASSES.NATIONAL,
    adapterType: ADAPTER_TYPES.GENERIC_HTML,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.RETAILER_REFERENCE,
    enabled: true,
    baseUrl: "https://www.johnlewis.com/",
    catalogueUrls: [
      "https://www.johnlewis.com/browse/baby-child/games-puzzles/view-all-games-puzzles/pok%C3%A9mon/card-games/_/N-6hxeZ1z079nuZ1yze6yu",
    ],
    productUrlPattern: /johnlewis\.com\/[^?#]+\/p\d+/i,
    skuPattern: /\/p(\d+)/i,
    pageParam: "page",
    maxPages: 2,
    delayMs: 1500,
    officialRrpSource: false,
    include: SEALED_POKEMON,
    exclude: /plush|puzzle|spinner|blanket|figure|clothing|bedding|stationery/i,
  }),
]);
