const COB_PIP_BASE_URL = 'https://cobandpip.co.uk';
const COB_PIP_SINGLES_COLLECTION = '/collections/pokemon-single-cards';
const DEFAULT_PAGE_LIMIT = 250;
const DEFAULT_MAX_PAGES = 20;

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

export function normalizeCobPipSingleCandidate(product, variant, { observedAt = Date.now() } = {}) {
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
    retailerId: 'cob-pip',
    retailerName: 'Cob & Pip',
    sellerType: 'retailer',
    tcg: 'pokemon',
    sourceKind: 'shopify_collection_products_json',
    sourceCollectionUrl: `${COB_PIP_BASE_URL}${COB_PIP_SINGLES_COLLECTION}`,
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
  fetchImpl = globalThis.fetch,
  observedAt = Date.now(),
  maxPages = DEFAULT_MAX_PAGES,
  pageLimit = DEFAULT_PAGE_LIMIT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const safeMaxPages = Math.max(1, Math.min(50, Number(maxPages) || DEFAULT_MAX_PAGES));
  const safeLimit = Math.max(1, Math.min(250, Number(pageLimit) || DEFAULT_PAGE_LIMIT));
  const candidates = [];
  const pages = [];

  for (let page = 1; page <= safeMaxPages; page += 1) {
    const url = `${COB_PIP_BASE_URL}${COB_PIP_SINGLES_COLLECTION}/products.json?limit=${safeLimit}&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'FateDrop/0.1 (+https://fate-drop.com; exact-card-pilot)' },
    });
    if (!response?.ok) {
      const error = new Error(`Cob & Pip singles pilot fetch failed (${response?.status ?? 'unknown'})`);
      error.status = response?.status ?? null;
      error.url = url;
      throw error;
    }
    const payload = await response.json();
    const products = Array.isArray(payload?.products) ? payload.products : [];
    const normalized = normalizeCobPipProductsPayload(payload, { observedAt });
    candidates.push(...normalized);
    pages.push(Object.freeze({ page, productCount: products.length, candidateCount: normalized.length }));
    if (products.length < safeLimit) break;
  }

  return Object.freeze({
    retailerId: 'cob-pip',
    sellerType: 'retailer',
    verificationStatus: 'staged',
    exactIdentityVerified: false,
    observedAt,
    pages: Object.freeze(pages),
    candidates: Object.freeze(candidates),
  });
}

export const __test = Object.freeze({
  COB_PIP_BASE_URL,
  COB_PIP_SINGLES_COLLECTION,
  collectorNumberHints,
});
