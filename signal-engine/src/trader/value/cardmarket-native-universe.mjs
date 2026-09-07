import {
  CARDMARKET_NATIVE_CURRENCY,
  CARDMARKET_SOURCE_NAME,
  hasMeaningfulCardmarketLane,
} from './cardmarket-adapter.mjs';

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requirePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function coveragePct(numerator, denominator) {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function productIdFromCatalogueProduct(product) {
  requireObject(product, 'products[]');
  if (product.sourceName !== CARDMARKET_SOURCE_NAME) {
    throw new TypeError('Cardmarket native universe requires Cardmarket catalogue products');
  }
  return String(requirePositiveInteger(product.sourceRecordId, 'products[].sourceRecordId'));
}

function productIdFromPriceRow(row) {
  requireObject(row, 'snapshot.priceGuides[]');
  return String(requirePositiveInteger(row.idProduct, 'snapshot.priceGuides[].idProduct'));
}

function makeExpansion(expansionId) {
  return {
    expansionId,
    productCount: 0,
    priceRowCount: 0,
    standardPricedProducts: 0,
    holoPricedProducts: 0,
    anyPricedProducts: 0,
  };
}

function finaliseExpansion(expansion) {
  return Object.freeze({
    ...expansion,
    standardCoveragePct: coveragePct(expansion.standardPricedProducts, expansion.productCount),
    holoCoveragePct: coveragePct(expansion.holoPricedProducts, expansion.productCount),
    anyPriceCoveragePct: coveragePct(expansion.anyPricedProducts, expansion.productCount),
  });
}

/**
 * Build a read-only view of Cardmarket's native Pokémon singles universe.
 *
 * This deliberately does not resolve FateDrop canonical card identity. FatePulse
 * needs broad market evidence grouped by Cardmarket expansion before every
 * exact card has completed the stricter FatePrice/FateCollector crosswalk.
 */
export function buildCardmarketNativeUniverseAudit({ products, snapshot } = {}) {
  requireArray(products, 'products');
  requireObject(snapshot, 'snapshot');
  requireArray(snapshot.priceGuides, 'snapshot.priceGuides');

  if (snapshot.sourceName !== CARDMARKET_SOURCE_NAME) {
    throw new TypeError('snapshot must be a Cardmarket price-guide snapshot');
  }
  if (snapshot.currencyCode !== CARDMARKET_NATIVE_CURRENCY) {
    throw new TypeError(`Cardmarket native universe currency must be ${CARDMARKET_NATIVE_CURRENCY}`);
  }

  const productsById = new Map();
  const expansions = new Map();
  let productsWithoutExpansion = 0;

  for (const product of products) {
    const productId = productIdFromCatalogueProduct(product);
    if (productsById.has(productId)) {
      throw new TypeError(`duplicate Cardmarket catalogue product id: ${productId}`);
    }
    productsById.set(productId, product);

    const rawExpansionId = product.sourceExpansionId;
    if (rawExpansionId == null) {
      productsWithoutExpansion += 1;
      continue;
    }
    const expansionId = String(requirePositiveInteger(rawExpansionId, 'products[].sourceExpansionId'));
    const expansion = expansions.get(expansionId) ?? makeExpansion(expansionId);
    expansion.productCount += 1;
    expansions.set(expansionId, expansion);
  }

  const priceRowsByProductId = new Map();
  let duplicatePriceRows = 0;
  let priceRowsWithoutCatalogueProduct = 0;

  for (const row of snapshot.priceGuides) {
    const productId = productIdFromPriceRow(row);
    if (priceRowsByProductId.has(productId)) {
      duplicatePriceRows += 1;
      continue;
    }
    priceRowsByProductId.set(productId, row);
    if (!productsById.has(productId)) priceRowsWithoutCatalogueProduct += 1;
  }

  let catalogueProductsWithPriceRow = 0;
  let standardPricedProducts = 0;
  let holoPricedProducts = 0;
  let anyPricedProducts = 0;

  for (const [productId, product] of productsById) {
    const row = priceRowsByProductId.get(productId);
    if (!row) continue;

    catalogueProductsWithPriceRow += 1;
    const hasStandard = hasMeaningfulCardmarketLane(row, 'standard');
    const hasHolo = hasMeaningfulCardmarketLane(row, 'holo');
    if (hasStandard) standardPricedProducts += 1;
    if (hasHolo) holoPricedProducts += 1;
    if (hasStandard || hasHolo) anyPricedProducts += 1;

    if (product.sourceExpansionId == null) continue;
    const expansionId = String(product.sourceExpansionId);
    const expansion = expansions.get(expansionId);
    if (!expansion) continue;
    expansion.priceRowCount += 1;
    if (hasStandard) expansion.standardPricedProducts += 1;
    if (hasHolo) expansion.holoPricedProducts += 1;
    if (hasStandard || hasHolo) expansion.anyPricedProducts += 1;
  }

  const expansionRows = [...expansions.values()]
    .map(finaliseExpansion)
    .sort((a, b) => Number(a.expansionId) - Number(b.expansionId));

  const catalogueProducts = productsById.size;
  const priceGuideRows = priceRowsByProductId.size;

  return Object.freeze({
    tcgCode: snapshot.tcgCode,
    sourceName: snapshot.sourceName,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    sourceEffectiveAt: snapshot.sourceEffectiveAt,
    currencyCode: snapshot.currencyCode,
    catalogueProducts,
    expansions: expansionRows.length,
    productsWithoutExpansion,
    priceGuideRows,
    duplicatePriceRows,
    catalogueProductsWithPriceRow,
    catalogueProductsWithoutPriceRow: catalogueProducts - catalogueProductsWithPriceRow,
    priceRowsWithoutCatalogueProduct,
    productPriceJoinCoveragePct: coveragePct(catalogueProductsWithPriceRow, catalogueProducts),
    standardPricedProducts,
    standardCoveragePct: coveragePct(standardPricedProducts, catalogueProducts),
    holoPricedProducts,
    holoCoveragePct: coveragePct(holoPricedProducts, catalogueProducts),
    anyPricedProducts,
    anyPriceCoveragePct: coveragePct(anyPricedProducts, catalogueProducts),
    expansionRows: Object.freeze(expansionRows),
  });
}
