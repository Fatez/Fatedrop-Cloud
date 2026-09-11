const COB_PIP_BASE_URL = 'https://cobandpip.co.uk';
const DEFAULT_PAGE_LIMIT = 250;
const DEFAULT_MAX_PAGES = 20;

// Keep this aligned with the canonical retailer registry. Exact-card offers,
// public retailer profiles and outbound attribution must all resolve to the
// same business identity.
export const COB_PIP_RETAILER = Object.freeze({ id: 'cob-and-pip', name: 'Cob & Pip' });

const DEFAULT_VARIANT_LANES = Object.freeze({
  base: Object.freeze(['standard', 'holo']),
  normal: Object.freeze(['standard', 'holo']),
  standard: Object.freeze(['standard']),
  holo: Object.freeze(['holo']),
  'rev holo': Object.freeze(['reverse-holo']),
  'reverse holo': Object.freeze(['reverse-holo']),
  'default title': Object.freeze(['standard', 'holo', 'reverse-holo']),
});

function reviewedBinding({
  key,
  collectionHandle,
  canonicalSetId = null,
  canonicalSetName,
  titleSuffixes = [],
  titlePrefixes = [],
  titleTrailingDescriptors = [],
  cardNameAliases = {},
}) {
  return Object.freeze({
    key,
    tcgCode: 'pokemon',
    collectionHandle,
    canonicalSetId,
    canonicalSetName,
    titleSuffixes: Object.freeze(titleSuffixes),
    titlePrefixes: Object.freeze(titlePrefixes),
    titleTrailingDescriptors: Object.freeze(titleTrailingDescriptors),
    variantLanes: DEFAULT_VARIANT_LANES,
    cardNameAliases: Object.freeze(cardNameAliases),
    reviewedAt: '2026-09-07',
  });
}

// This manifest mirrors Cob & Pip's public Pokemon singles directory. A
// retailer collection is allowed to enter exact-card resolution only through a
// reviewed binding here. Where FateDrop does not yet have one unique verified
// canonical set, canonicalSetId stays null and the collection remains held.
// It may never fall back to fuzzy title matching.
export const COB_PIP_SINGLE_COLLECTIONS = Object.freeze({
  'pokemon-pitch-black': reviewedBinding({
    key: 'pokemon-pitch-black',
    collectionHandle: 'pokemon-mega-evolution-pitch-black',
    canonicalSetId: 'fdset_7d264fd7394a646e20920bd5',
    canonicalSetName: 'Pitch Black',
    titleSuffixes: ['Mega Evolution Pitch Black', 'Mega Evolutions Pitch Black', 'Pitch Black'],
  }),
  'pokemon-chaos-rising': reviewedBinding({
    key: 'pokemon-chaos-rising',
    collectionHandle: 'pokemon-mega-evolution-chaos-rising',
    canonicalSetId: 'fdset_40b2ad368841bbd285a0df18',
    canonicalSetName: 'Chaos Rising',
    titleSuffixes: ['Pokemon Mega Evolution Chaos Rising', 'Pokémon Mega Evolution Chaos Rising', 'Mega Evolution Chaos Rising', 'Mega Evolutions Chaos Rising', 'Chaos Rising'],
    // Retailer wording differs from the exact canonical card names for these
    // three energies. These aliases are collector-number scoped and reviewed.
    cardNameAliases: {
      '84': Object.freeze({ 'Bubbly Energy': 'Bubbly Water Energy' }),
      '85': Object.freeze({ 'Magnetic Energy': 'Magnetic Metal Energy' }),
      '86': Object.freeze({ 'Nitro Energy': 'Nitro Fire Energy' }),
    },
  }),
  'pokemon-perfect-order': reviewedBinding({
    key: 'pokemon-perfect-order',
    collectionHandle: 'pokemon-perfect-order',
    canonicalSetId: 'fdset_9eefa55857667343f05ff2a4',
    canonicalSetName: 'Perfect Order',
    titleSuffixes: ['Mega Evolution Perfect Order', 'Mega Evolutions Perfect Order', 'Perfect Order'],
  }),
  'pokemon-ascended-heroes': reviewedBinding({
    key: 'pokemon-ascended-heroes',
    collectionHandle: 'pokemon-mega-evolutions-ascended-heroes',
    canonicalSetId: 'fdset_03123513d7bbb5eb82bf1d7b',
    canonicalSetName: 'Ascended Heroes',
    titleSuffixes: [
      'Mega Evolution Ascended Heroes',
      'Mega Evolutions Ascended Heroes',
      'Mega Evolution Ascended Hero',
      'Mega Evolutions Ascended Hero',
      "Mega Evolution Ascended Hero's",
      "Mega Evolutions Ascended Hero's",
      'Ascended Heroes',
    ],
  }),
  'pokemon-phantasmal-flames': reviewedBinding({
    key: 'pokemon-phantasmal-flames',
    collectionHandle: 'pokemon-mega-evolution-phantasmal-flames',
    canonicalSetId: 'fdset_3d47264244b348ab49688271',
    canonicalSetName: 'Phantasmal Flames',
    titleSuffixes: ['Mega Evolution Phantasmal Flames', 'Mega Evolutions Phantasmal Flames', 'Phantasmal Flames'],
  }),
  'pokemon-mega-evolution': reviewedBinding({
    key: 'pokemon-mega-evolution',
    collectionHandle: 'pokemon-mega-evolution',
    canonicalSetId: 'fdset_e99ffd8dcd8e0ade2d63db5f',
    canonicalSetName: 'Mega Evolution',
    titleSuffixes: ['Pokemon Mega Evolution', 'Pokémon Mega Evolution', 'Mega Evolution', 'Mega Evolutions'],
  }),

  'pokemon-black-bolt': reviewedBinding({
    key: 'pokemon-black-bolt',
    collectionHandle: 'pokemon-sv-black-bolt',
    canonicalSetName: 'Black Bolt',
    titleSuffixes: ['Pokemon SV Black Bolt', 'Pokémon SV Black Bolt', 'Black Bolt'],
  }),
  'pokemon-destined-rivals': reviewedBinding({
    key: 'pokemon-destined-rivals',
    collectionHandle: 'pokemon-destined-rivals-singles',
    canonicalSetName: 'Destined Rivals',
    titleSuffixes: ['Pokemon SV Destined Rivals', 'Pokémon SV Destined Rivals', 'Destined Rivals'],
  }),
  'pokemon-journey-together': reviewedBinding({
    key: 'pokemon-journey-together',
    collectionHandle: 'pokemon-sv-journey-together',
    canonicalSetName: 'Journey Together',
    titleSuffixes: ['Pokemon SV Journey Together', 'Pokémon SV Journey Together', 'Journey Together'],
  }),
  'pokemon-151': reviewedBinding({
    key: 'pokemon-151',
    collectionHandle: 'pokemon-sv-151',
    canonicalSetId: 'fdset_067d68020460e775d43ff0cb',
    canonicalSetName: '151',
    titleSuffixes: ['Pokemon SV 151', 'Pokémon SV 151', '151'],
    cardNameAliases: {
      '29': Object.freeze({ 'Nidoran ♀': 'Nidoran♀' }),
      '75': Object.freeze({ Gravelar: 'Graveler' }),
      '83': Object.freeze({ "Farfeth'd": "Farfetch'd" }),
    },
  }),
  'pokemon-prismatic-evolutions': reviewedBinding({
    key: 'pokemon-prismatic-evolutions',
    collectionHandle: 'pokemon-prismatic-evolutions-singles',
    canonicalSetId: 'fdset_20b6a6dcfa52bbe0cc54b919',
    canonicalSetName: 'Prismatic Evolutions',
    titleSuffixes: ['Pokemon Prismatic Evolutions', 'Pokémon Prismatic Evolutions', 'Prismatic Evolutions'],
  }),
  'pokemon-surging-sparks': reviewedBinding({
    key: 'pokemon-surging-sparks',
    collectionHandle: 'pokemon-surging-sparks-singles',
    canonicalSetId: 'fdset_259c8dc9998c17928a9b734d',
    canonicalSetName: 'Surging Sparks',
    titleSuffixes: ['Pokemon SV Surging Sparks', 'Pokémon SV Surging Sparks', 'Surging Sparks'],
  }),
  'pokemon-stellar-crown': reviewedBinding({
    key: 'pokemon-stellar-crown',
    collectionHandle: 'pokemon-stellar-crown-singles',
    canonicalSetName: 'Stellar Crown',
    titleSuffixes: ['Pokemon SV Stellar Crown', 'Pokémon SV Stellar Crown', 'Stellar Crown'],
    titleTrailingDescriptors: ['Mint Pack Fresh', 'Pack Fresh'],
  }),
  'pokemon-twilight-masquerade': reviewedBinding({
    key: 'pokemon-twilight-masquerade',
    collectionHandle: 'pokemon-twilight-masquerade-singles',
    canonicalSetId: 'fdset_d0acd7a6c3bd0931d2613fb1',
    canonicalSetName: 'Twilight Masquerade',
    // This collection uses both "#001 Card Set" and "#001 Set Card" titles.
    titleSuffixes: ['Pokemon SV Twilight Masquerade', 'Pokémon SV Twilight Masquerade', 'Twilight Masquerade'],
    titlePrefixes: ['Pokemon SV Twilight Masquerade', 'Pokémon SV Twilight Masquerade', 'Twilight Masquerade'],
  }),
  'pokemon-temporal-forces': reviewedBinding({
    key: 'pokemon-temporal-forces',
    collectionHandle: 'pokemon-temporal-forces-singles',
    canonicalSetId: 'fdset_15b58d7fe24f94690c51184b',
    canonicalSetName: 'Temporal Forces',
    titleSuffixes: ['Pokemon SV Temporal Forces', 'Pokémon SV Temporal Forces', 'Temporal Forces'],
  }),
  'pokemon-paldean-fates': reviewedBinding({
    key: 'pokemon-paldean-fates',
    collectionHandle: 'pokemon-paldean-fates-singles',
    canonicalSetName: 'Paldean Fates',
    titleSuffixes: ['Pokemon SV Paldean Fates', 'Pokémon SV Paldean Fates', 'Paldean Fates'],
  }),
  'pokemon-paradox-rift': reviewedBinding({
    key: 'pokemon-paradox-rift',
    collectionHandle: 'pokemon-paradox-rift-singles',
    canonicalSetId: 'fdset_559eec0428699e3f691a8ecb',
    canonicalSetName: 'Paradox Rift',
    titleSuffixes: ['Pokemon SV Paradox Rift', 'Pokémon SV Paradox Rift', 'Paradox Rift'],
  }),
  'pokemon-obsidian-flames': reviewedBinding({
    key: 'pokemon-obsidian-flames',
    collectionHandle: 'pokemon-obsidian-flames-singles',
    canonicalSetId: 'fdset_5d5fcf56792f8acb162e4929',
    canonicalSetName: 'Obsidian Flames',
    titleSuffixes: ['Pokemon SV Obsidian Flames', 'Pokémon SV Obsidian Flames', 'Obsidian Flames'],
  }),
  'pokemon-shrouded-fable': reviewedBinding({
    key: 'pokemon-shrouded-fable',
    collectionHandle: 'pokemon-sv-shrouded-fable',
    canonicalSetId: 'fdset_4178773980bacce35fafac2e',
    canonicalSetName: 'Shrouded Fable',
    titleSuffixes: ['Pokemon SV Shrouded Fable', 'Pokémon SV Shrouded Fable', 'Shrouded Fable'],
  }),
  'pokemon-scarlet-violet': reviewedBinding({
    key: 'pokemon-scarlet-violet',
    collectionHandle: 'pokemon-scarlet-violet-base-set-singles',
    canonicalSetName: 'Scarlet & Violet',
    titleSuffixes: ['Pokemon Scarlet and Violet', 'Pokémon Scarlet and Violet', 'Scarlet & Violet', 'Scarlet and Violet'],
  }),

  'pokemon-vivid-voltage': reviewedBinding({
    key: 'pokemon-vivid-voltage',
    collectionHandle: 'pokemon-vivid-voltage-singles',
    canonicalSetName: 'Vivid Voltage',
    titleSuffixes: ['Pokemon Vivid Voltage', 'Pokémon Vivid Voltage', 'Vivid Voltage'],
  }),
  'pokemon-fusion-strike': reviewedBinding({
    key: 'pokemon-fusion-strike',
    collectionHandle: 'pokemon-fusion-strike-singles',
    canonicalSetName: 'Fusion Strike',
    titleSuffixes: ['Pokemon Fusion Strike', 'Pokémon Fusion Strike', 'Fusion Strike'],
  }),
  'pokemon-silver-tempest': reviewedBinding({
    key: 'pokemon-silver-tempest',
    collectionHandle: 'pokemon-silver-tempest-singles',
    canonicalSetName: 'Silver Tempest',
    titleSuffixes: ['Pokemon Silver Tempest', 'Pokémon Silver Tempest', 'Silver Tempest'],
  }),
  'pokemon-astral-radiance': reviewedBinding({
    key: 'pokemon-astral-radiance',
    collectionHandle: 'pokemon-astral-radiance-singles',
    canonicalSetName: 'Astral Radiance',
    titleSuffixes: ['Pokemon Astral Radiance', 'Pokémon Astral Radiance', 'Astral Radiance'],
  }),
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function moneyToPence(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function canonicalProductUrl(handle) {
  const clean = text(handle);
  return clean ? `${COB_PIP_BASE_URL}/products/${encodeURIComponent(clean)}` : null;
}

function collectorNumberHints(...parts) {
  const value = parts.map(text).filter(Boolean).join(' ');
  const hints = [];
  const seen = new Set();
  const patterns = [
    /(?:^|\s|[-–—(])#\s*(\d{1,4}[a-z]?)(?:\s*\/\s*(\d{1,4}))?/gi,
    /(?:^|\s|[-–—(])(\d{1,4}[a-z]?)\s*\/\s*(\d{1,4})(?:\s|$|[)\],])/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(value)) != null) {
      const cardNumber = text(match[1]).toUpperCase();
      const setSize = text(match[2]);
      const key = `${cardNumber}/${setSize}`;
      if (!cardNumber || seen.has(key)) continue;
      seen.add(key);
      hints.push(Object.freeze({ cardNumber, setSize: setSize || null }));
    }
  }
  return Object.freeze(hints);
}

function variantAvailable(variant) {
  return variant?.available === true;
}

function collectionBinding(value) {
  if (value && typeof value === 'object') return value;
  const key = text(value) || 'pokemon-151';
  const binding = COB_PIP_SINGLE_COLLECTIONS[key];
  if (!binding) throw new TypeError(`Unsupported Cob & Pip singles collection: ${key}`);
  return binding;
}

export function normalizeCobPipSingleCandidate(product, variant, { observedAt = Date.now(), collection = 'pokemon-151' } = {}) {
  const binding = collectionBinding(collection);
  const productId = integer(product?.id);
  const variantId = integer(variant?.id);
  const productTitle = text(product?.title);
  const variantTitle = text(variant?.title);
  const sku = text(variant?.sku);
  const handle = text(product?.handle);
  const pricePence = moneyToPence(variant?.price);
  const url = canonicalProductUrl(handle);
  const imageUrl = text(variant?.featured_image?.src) || text(product?.image?.src) || text(product?.images?.[0]?.src) || null;
  const observedMs = Number(observedAt);

  if (productId == null || variantId == null || !productTitle || !url) return null;

  return Object.freeze({
    retailerId: COB_PIP_RETAILER.id,
    retailerName: COB_PIP_RETAILER.name,
    sellerType: 'retailer',
    tcg: 'pokemon',
    sourceKind: 'shopify_collection_products_json',
    sourceCollectionKey: binding.key,
    sourceCollectionHandle: binding.collectionHandle,
    sourceCollectionUrl: `${COB_PIP_BASE_URL}/collections/${binding.collectionHandle}`,
    retailerProductId: String(productId),
    retailerVariantId: String(variantId),
    retailerSku: sku || `shopify-variant-${variantId}`,
    title: variantTitle && variantTitle.toLowerCase() !== 'default title'
      ? `${productTitle} — ${variantTitle}`
      : productTitle,
    productTitle,
    variantTitle: variantTitle || null,
    url,
    imageUrl,
    currencyCode: 'GBP',
    pricePence,
    stockStatus: variantAvailable(variant) ? 'in_stock' : 'out_of_stock',
    stockConfidence: 1,
    stockQuantity: null,
    observedAt: Number.isFinite(observedMs) ? Math.floor(observedMs / 1000) : null,
    identityHints: Object.freeze({
      collectorNumbers: collectorNumberHints(productTitle, variantTitle, sku),
      sku: sku || null,
      productHandle: handle,
    }),
    // Critical safety boundary: discovery can never publish an exact-card offer.
    // A separate exact canonical crosswalk must promote this to `verified`.
    verificationStatus: 'staged',
    exactIdentityVerified: false,
  });
}

export function normalizeCobPipProductsPayload(payload, options = {}) {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const candidates = [];
  for (const product of products) {
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    for (const variant of variants) {
      const candidate = normalizeCobPipSingleCandidate(product, variant, options);
      if (candidate) candidates.push(candidate);
    }
  }
  return Object.freeze(candidates);
}

export async function collectCobPipSinglesPilot({
  collection = 'pokemon-151',
  fetchImpl = globalThis.fetch,
  observedAt = Date.now(),
  maxPages = DEFAULT_MAX_PAGES,
  pageLimit = DEFAULT_PAGE_LIMIT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const binding = collectionBinding(collection);
  const safeMaxPages = Math.max(1, Math.min(50, Number(maxPages) || DEFAULT_MAX_PAGES));
  const safeLimit = Math.max(1, Math.min(250, Number(pageLimit) || DEFAULT_PAGE_LIMIT));
  const candidates = [];
  const pages = [];

  for (let page = 1; page <= safeMaxPages; page += 1) {
    const url = `${COB_PIP_BASE_URL}/collections/${binding.collectionHandle}/products.json?limit=${safeLimit}&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'FateDrop/0.1 (+https://fate-drop.com; exact-card-retailer-network)' },
    });
    if (!response?.ok) {
      const error = new Error(`Cob & Pip singles fetch failed (${response?.status ?? 'unknown'})`);
      error.status = response?.status ?? null;
      error.url = url;
      throw error;
    }
    const payload = await response.json();
    const products = Array.isArray(payload?.products) ? payload.products : [];
    const normalized = normalizeCobPipProductsPayload(payload, { observedAt, collection: binding });
    candidates.push(...normalized);
    pages.push(Object.freeze({ page, productCount: products.length, candidateCount: normalized.length }));
    if (products.length < safeLimit) break;
  }

  return Object.freeze({
    retailerId: COB_PIP_RETAILER.id,
    sellerType: 'retailer',
    collection: binding,
    verificationStatus: 'staged',
    exactIdentityVerified: false,
    observedAt,
    pages: Object.freeze(pages),
    candidates: Object.freeze(candidates),
  });
}

export const __test = Object.freeze({
  COB_PIP_BASE_URL,
  collectorNumberHints,
  collectionBinding,
  reviewedBinding,
});
