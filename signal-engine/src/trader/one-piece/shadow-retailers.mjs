import { ADAPTER_TYPES, RETAILER_CLASSES, RRP_AUTHORITY, VERIFICATION_STATES } from '../../retailers/registry.mjs';
import { ONE_PIECE_SHADOW_FILTERS } from './sealed-product-intelligence.mjs';

function shopifyShadowRetailer({ id, name, baseUrl, collection, retailerClass = RETAILER_CLASSES.INDEPENDENT, maxPages = 2 }) {
  return Object.freeze({
    id,
    name,
    tcg: 'one-piece',
    tcgs: Object.freeze(['one-piece']),
    retailerClass,
    adapterType: ADAPTER_TYPES.SHOPIFY,
    verification: VERIFICATION_STATES.PENDING,
    rrpAuthority: RRP_AUTHORITY.NONE,
    enabled: false,
    observationOnly: true,
    baseUrl,
    catalogue: Object.freeze({
      feedUrl: new URL(`${collection.replace(/\/$/, '')}/products.json?limit=250`, baseUrl).toString(),
      // Shadow qualification opts in per call. This can never place the feed in
      // the production retailer runtime or create canonical lifecycle signals.
      feedApproved: false,
      marketCountry: 'GB',
      runtime: Object.freeze({ maxPages, delayMs: 1200 }),
    }),
    officialRrpSource: false,
    include: ONE_PIECE_SHADOW_FILTERS.include,
    exclude: ONE_PIECE_SHADOW_FILTERS.exclude,
  });
}

export const onePieceShadowRetailers = Object.freeze([
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
]);
