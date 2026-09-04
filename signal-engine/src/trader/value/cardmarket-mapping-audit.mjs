import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { findCardmarketCrosswalkCandidates } from './cardmarket-crosswalk.mjs';

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function expansionId(product) {
  const value = Number(product?.sourceExpansionId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exactNameSet(values) {
  const names = new Set();
  for (const value of values) {
    const name = normaliseComparableName(value);
    if (name) names.add(name);
  }
  return names;
}

function verifiedPrintingNames(cards) {
  const byPrinting = new Map();
  for (const card of cards) {
    if (!card || card.verificationStatus !== 'verified' || typeof card.name !== 'string') continue;
    const key = String(card.printingId || `${card.collectorNumber || ''}|${card.name}`);
    if (!byPrinting.has(key)) byPrinting.set(key, card.name);
  }
  return exactNameSet([...byPrinting.values()]);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

export function rankCardmarketExpansionEvidence(products, verifiedSetCards, { limit = 10 } = {}) {
  requireArray(products, 'products');
  requireArray(verifiedSetCards, 'verifiedSetCards');
  const canonicalNames = verifiedPrintingNames(verifiedSetCards);
  if (!canonicalNames.size) throw new Error('verified set contains no exact card names');

  const groups = new Map();
  for (const product of products) {
    const id = expansionId(product);
    if (!id || product?.sourceName !== 'cardmarket') continue;
    const rows = groups.get(id) || [];
    rows.push(product);
    groups.set(id, rows);
  }

  const evidence = [];
  for (const [id, rows] of groups) {
    const productNames = exactNameSet(rows.map((row) => row.name));
    let overlap = 0;
    for (const name of canonicalNames) if (productNames.has(name)) overlap += 1;
    if (!overlap) continue;
    evidence.push(Object.freeze({
      sourceExpansionId: id,
      sourceProductCount: rows.length,
      sourceDistinctNameCount: productNames.size,
      canonicalDistinctNameCount: canonicalNames.size,
      exactNameOverlap: overlap,
      canonicalExactNameCoverage: ratio(overlap, canonicalNames.size),
      sourceExactNamePrecision: ratio(overlap, productNames.size),
      status: 'evidence_only',
      approved: false,
    }));
  }

  evidence.sort((left, right) => (
    right.canonicalExactNameCoverage - left.canonicalExactNameCoverage
    || right.exactNameOverlap - left.exactNameOverlap
    || right.sourceExactNamePrecision - left.sourceExactNamePrecision
    || left.sourceExpansionId - right.sourceExpansionId
  ));
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
  return Object.freeze(evidence.slice(0, safeLimit));
}

export function auditApprovedCardmarketExpansion(products, verifiedSetCards, sourceExpansionId) {
  requireArray(products, 'products');
  requireArray(verifiedSetCards, 'verifiedSetCards');
  const id = Number(sourceExpansionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('sourceExpansionId must be a positive integer');

  const scopedProducts = products.filter((product) => product?.sourceName === 'cardmarket' && expansionId(product) === id);
  if (!scopedProducts.length) throw new Error(`Cardmarket expansion ${id} contains no catalogue products`);

  const diagnostics = scopedProducts.map((product) => {
    const crosswalk = findCardmarketCrosswalkCandidates(product, verifiedSetCards);
    return Object.freeze({
      sourceRecordId: product.sourceRecordId,
      sourceExpansionId: id,
      productName: product.name,
      status: crosswalk.status,
      reason: crosswalk.reason,
      candidates: crosswalk.candidates || Object.freeze([]),
      autoMappable: false,
    });
  });

  const counts = {
    sourceProducts: diagnostics.length,
    exactUniquePrintingCandidates: 0,
    variantConfirmationRequired: 0,
    ambiguous: 0,
    unresolved: 0,
  };
  const reasons = {};
  for (const row of diagnostics) {
    reasons[row.reason] = (reasons[row.reason] || 0) + 1;
    if (row.status === 'ambiguous') counts.ambiguous += 1;
    else if (row.status === 'unresolved') counts.unresolved += 1;
    else if (row.status === 'candidate' && row.candidates.length === 1) counts.exactUniquePrintingCandidates += 1;
    else if (row.status === 'candidate') counts.variantConfirmationRequired += 1;
  }

  return Object.freeze({
    sourceExpansionId: id,
    approvedExpansionScopeRequired: true,
    writesPerformed: false,
    counts: Object.freeze({
      ...counts,
      exactUniqueCandidateCoverage: ratio(counts.exactUniquePrintingCandidates, counts.sourceProducts),
    }),
    reasons: Object.freeze(reasons),
    diagnostics: Object.freeze(diagnostics),
  });
}
