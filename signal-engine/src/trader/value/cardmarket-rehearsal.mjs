import { buildCardmarketPriceGuideBatch } from './cardmarket-adapter.mjs';
import { adaptCardmarketCatalogue } from './cardmarket-catalogue-adapter.mjs';
import { findCardmarketCrosswalkCandidates } from './cardmarket-crosswalk.mjs';

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} function is required`);
  return value;
}

function productIndex(products) {
  return new Map(products.map((product) => [String(product.sourceRecordId), product]));
}

function compactRejection(rejection) {
  return Object.freeze({
    rejectionId: rejection.id,
    sourceRecordId: rejection.sourceRecordId,
    sourceVariantKey: rejection.sourceVariantKey,
    rejectionCode: rejection.rejectionCode,
    rejectionDetail: rejection.rejectionDetail,
  });
}

export async function buildCardmarketRehearsalReport({
  cataloguePayload,
  priceGuidePayload,
  resolveMapping,
  resolveVerifiedSetCards,
  observedAt = Date.now(),
} = {}) {
  requireFunction(resolveMapping, 'resolveMapping');
  requireFunction(resolveVerifiedSetCards, 'resolveVerifiedSetCards');

  const products = adaptCardmarketCatalogue(cataloguePayload);
  const productsById = productIndex(products);
  const batch = await buildCardmarketPriceGuideBatch(priceGuidePayload, {
    resolveMapping,
    observedAt,
  });

  const diagnostics = [];
  for (const rejection of batch.rejections) {
    if (rejection.rejectionCode !== 'identity_unresolved') {
      diagnostics.push(Object.freeze({
        ...compactRejection(rejection),
        status: 'blocked',
        reason: rejection.rejectionCode,
        product: null,
        crosswalk: null,
      }));
      continue;
    }

    const product = productsById.get(String(rejection.sourceRecordId));
    if (!product) {
      diagnostics.push(Object.freeze({
        ...compactRejection(rejection),
        status: 'unresolved',
        reason: 'catalogue_product_missing',
        product: null,
        crosswalk: null,
      }));
      continue;
    }

    // Set scope is mandatory. The Cardmarket product name is never compared
    // against the global FateDrop card catalogue because that would turn a
    // convenience rehearsal into a fuzzy identity engine.
    const verifiedSetCards = await resolveVerifiedSetCards(product);
    if (!Array.isArray(verifiedSetCards)) {
      diagnostics.push(Object.freeze({
        ...compactRejection(rejection),
        status: 'unresolved',
        reason: 'verified_set_crosswalk_required',
        product,
        crosswalk: null,
      }));
      continue;
    }

    const crosswalk = findCardmarketCrosswalkCandidates(product, verifiedSetCards);
    diagnostics.push(Object.freeze({
      ...compactRejection(rejection),
      status: crosswalk.status,
      reason: crosswalk.reason,
      product,
      crosswalk,
    }));
  }

  return Object.freeze({
    mode: 'dry-run',
    persistenceAuthorized: false,
    sourceName: batch.snapshot.sourceName,
    sourceSnapshotId: batch.snapshot.sourceSnapshotId,
    sourceCurrency: batch.snapshot.currencyCode,
    catalogueProducts: products.length,
    sourceRows: batch.snapshot.priceGuides.length,
    wouldInsert: batch.observations.length,
    wouldReject: batch.rejections.length,
    observations: batch.observations,
    rejections: batch.rejections,
    diagnostics: Object.freeze(diagnostics),
    run: batch.run,
  });
}
