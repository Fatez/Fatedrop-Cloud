import { ADAPTER_TYPES, RETAILER_CLASSES, RRP_AUTHORITY, VERIFICATION_STATES } from '../../retailers/registry.mjs';
import { ONE_PIECE_SHADOW_FILTERS } from './sealed-product-intelligence.mjs';

function shadowSafety({ id, name, retailerClass, adapterType, baseUrl }) {
  return {
    id,
    name,
    tcg: 'one-piece',
    tcgs: Object.freeze(['one-piece']),
    retailerClass,
    adapterType,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.NONE,
    enabled: false,
    observationOnly: true,
    baseUrl,
    officialRrpSource: false,
    include: ONE_PIECE_SHADOW_FILTERS.include,
    exclude: ONE_PIECE_SHADOW_FILTERS.exclude,
  };
}

function shopifyShadowRetailer({ id, name, baseUrl, collection, retailerClass = RETAILER_CLASSES.INDEPENDENT, maxPages = 2, delayMs = 1200 }) {
  return Object.freeze({
    ...shadowSafety({ id, name, retailerClass, adapterType: ADAPTER_TYPES.SHOPIFY, baseUrl }),
    catalogue: Object.freeze({
      feedUrl: new URL(`${collection.replace(/\/$/, '')}/products.json?limit=250`, baseUrl).toString(),
      // Shadow qualification opts in per call. This can never place the feed in
      // the production retailer runtime or create canonical lifecycle signals.
      feedApproved: false,
      marketCountry: 'GB',
      runtime: Object.freeze({ maxPages, delayMs }),
    }),
  });
}

function genericHtmlShadowRetailer({
  id,
  name,
  baseUrl,
  catalogueUrls,
  productUrlPattern,
  skuPattern,
  retailerClass = RETAILER_CLASSES.SPECIALIST,
  pageParam = 'page',
  maxPages = 8,
  delayMs = 1800,
  stencilTemplate = null,
}) {
  return Object.freeze({
    ...shadowSafety({ id, name, retailerClass, adapterType: ADAPTER_TYPES.GENERIC_HTML, baseUrl }),
    catalogueUrls: Object.freeze(catalogueUrls),
    productUrlPattern,
    skuPattern,
    pageParam,
    maxPages,
    delayMs,
    catalogue: Object.freeze({
      // Generic HTML shadow sources do not use feed approval for routing, but
      // keeping the same explicit false flag makes their non-production status
      // auditable alongside Shopify candidates.
      feedApproved: false,
      marketCountry: 'GB',
      ...(stencilTemplate ? { stencilTemplate } : {}),
    }),
  });
}

export const onePieceShadowRetailers = Object.freeze([
  // Initial clean Shopify qualification cohort.
  shopifyShadowRetailer({
    id: 'cob-and-pip',
    name: 'Cob & Pip',
    baseUrl: 'https://cobandpip.co.uk/',
    collection: '/collections/one-piece-sealed',
  }),
  shopifyShadowRetailer({
    id: 'lz-collectibles',
    name: 'LZ Collectibles',
    baseUrl: 'https://lzcollectibles.com/',
    collection: '/collections/opcg',
  }),
  shopifyShadowRetailer({
    id: 'card-goblin',
    name: 'Card Goblin',
    baseUrl: 'https://www.cardgoblin.shop/',
    collection: '/collections/one-piece',
  }),
  shopifyShadowRetailer({
    id: 'the-card-club-uk',
    name: 'The Card Club UK',
    baseUrl: 'https://thecardclubuk.shop/',
    collection: '/collections/one-piece-card-game',
  }),
  shopifyShadowRetailer({
    id: 'shake-central',
    name: 'Shake Central',
    baseUrl: 'https://shakecentral.co.uk/',
    collection: '/collections/one-piece',
  }),

  // Existing FateDrop retailer identities with verified One Piece catalogue
  // surfaces. These remain a shadow projection of the shared retailer identity;
  // they do not create duplicate retailers or change the live Pokemon runtime.
  genericHtmlShadowRetailer({
    id: 'magic-madhouse',
    name: 'Magic Madhouse',
    baseUrl: 'https://magicmadhouse.co.uk/',
    catalogueUrls: ['https://magicmadhouse.co.uk/one-piece-card-game/'],
    productUrlPattern: /magicmadhouse\.co\.uk\/one-piece-card-game-[a-z0-9][a-z0-9-]+\/?(?:\?.*)?$/i,
    skuPattern: /\/one-piece-card-game-([^/?#]+)/i,
    // The top-level One Piece catalogue is a valid public HTML surface, but
    // later synthetic pagination can return a hard 404. Keep shadow discovery
    // bounded to the proven root page rather than interpreting a 404 as stock.
    maxPages: 1,
    delayMs: 2200,
  }),
  genericHtmlShadowRetailer({
    id: 'chaos-cards',
    name: 'Chaos Cards',
    baseUrl: 'https://www.chaoscards.co.uk/',
    catalogueUrls: ['https://www.chaoscards.co.uk/shop/card-games/one-piece-card-game/one-piece-card-game-sealed-products'],
    productUrlPattern: /chaoscards\.co\.uk\/prod\//i,
    skuPattern: /\/prod\/[^/]+\/([^/?#]+)$/i,
    maxPages: 12,
    delayMs: 1800,
  }),
  shopifyShadowRetailer({
    id: 'double-sleeved',
    name: 'Double Sleeved',
    baseUrl: 'https://www.doublesleeved.co.uk/',
    collection: '/collections/one-piece-card-game',
    maxPages: 4,
  }),
  shopifyShadowRetailer({
    id: 'total-cards',
    name: 'Total Cards',
    baseUrl: 'https://totalcards.net/',
    collection: '/collections/one-piece',
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    maxPages: 6,
  }),
  shopifyShadowRetailer({
    id: 'titan-cards',
    name: 'Titan Cards',
    baseUrl: 'https://titancards.co.uk/',
    collection: '/collections/one-piece-card-game',
    maxPages: 4,
  }),
  shopifyShadowRetailer({
    id: 'eterna-cards',
    name: 'Eterna Cards',
    baseUrl: 'https://eternacards.co.uk/',
    collection: '/collections/one-piece-trading-card-game',
    maxPages: 4,
  }),
  shopifyShadowRetailer({
    id: 'jet-cards',
    name: 'JET Cards',
    baseUrl: 'https://jetcards.uk/',
    collection: '/collections/one-piece-card-game',
    maxPages: 4,
  }),
  shopifyShadowRetailer({
    id: 'gathering-games',
    name: 'Gathering Games',
    baseUrl: 'https://gatheringgames.co.uk/',
    collection: '/collections/one-piece-card-game',
    maxPages: 4,
  }),
  shopifyShadowRetailer({
    id: 'zatu-games',
    name: 'Zatu Games',
    baseUrl: 'https://zatu.com/',
    collection: '/collections/one-piece',
    retailerClass: RETAILER_CLASSES.SPECIALIST,
    maxPages: 4,
    delayMs: 2500,
  }),
]);
