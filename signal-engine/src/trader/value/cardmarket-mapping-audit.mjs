import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import {
  cardmarketStructuredPrintingKey,
  findCardmarketCrosswalkCandidates,
  parseCardmarketSingleProductName,
} from './cardmarket-crosswalk.mjs';

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function expansionId(product) {
  const value = Number(product?.sourceExpansionId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeSetCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function verifiedPrintingKeys(cards) {
  const keys = new Set();
  for (const card of cards) {
    if (!card || card.verificationStatus !== 'verified' || typeof card.name !== 'string') continue;
    let number;
    try {
      number = normaliseCollectorNumber(card.collectorNumber);
    } catch {
      continue;
    }
    keys.add(`${number}|${normaliseComparableName(card.name)}`);
  }
  return keys;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

export function rankCardmarketExpansionEvidence(products, verifiedSetCards, {
  limit = 10,
  expectedSourceSetCode = null,
} = {}) {
  requireArray(products, 'products');
  requireArray(verifiedSetCards, 'verifiedSetCards');
  const canonicalKeys = verifiedPrintingKeys(verifiedSetCards);
  if (!canonicalKeys.size) throw new Error('verified set contains no exact card printing keys');
  const expectedCode = normalizeSetCode(expectedSourceSetCode);

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
    const structuredRows = [];
    const sourceSetCodes = {};
    for (const row of rows) {
      const parsed = parseCardmarketSingleProductName(row.name);
      if (!parsed) continue;
      const code = normalizeSetCode(parsed.sourceSetCode);
      sourceSetCodes[code] = (sourceSetCodes[code] || 0) + 1;
      if (expectedCode && code !== expectedCode) continue;
      const key = cardmarketStructuredPrintingKey(row);
      if (key) structuredRows.push({ row, parsed, key });
    }

    if (expectedCode && structuredRows.length === 0) continue;
    const productKeys = new Set(structuredRows.map((entry) => entry.key));
    let overlap = 0;
    for (const key of canonicalKeys) if (productKeys.has(key)) overlap += 1;
    if (!overlap) continue;

    evidence.push(Object.freeze({
      sourceExpansionId: id,
      sourceProductCount: rows.length,
      structuredProductCount: structuredRows.length,
      sourceDistinctPrintingKeyCount: productKeys.size,
      canonicalDistinctPrintingKeyCount: canonicalKeys.size,
      exactPrintingKeyOverlap: overlap,
      canonicalExactPrintingCoverage: ratio(overlap, canonicalKeys.size),
      sourceExactPrintingPrecision: ratio(overlap, productKeys.size),
      expectedSourceSetCode: expectedCode || null,
      expectedSourceSetCodeProducts: expectedCode ? structuredRows.length : null,
      sourceSetCodes: Object.freeze(sourceSetCodes),
      status: 'evidence_only',
      approved: false,
    }));
  }

  evidence.sort((left, right) => (
    right.canonicalExactPrintingCoverage - left.canonicalExactPrintingCoverage
    || right.exactPrintingKeyOverlap - left.exactPrintingKeyOverlap
    || right.sourceExactPrintingPrecision - left.sourceExactPrintingPrecision
    || left.sourceExpansionId - right.sourceExpansionId
  ));
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
  return Object.freeze(evidence.slice(0, safeLimit));
}

export function auditApprovedCardmarketExpansion(products, verifiedSetCards, sourceExpansionId, {
  expectedSourceSetCode = null,
} = {}) {
  requireArray(products, 'products');
  requireArray(verifiedSetCards, 'verifiedSetCards');
  const id = Number(sourceExpansionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('sourceExpansionId must be a positive integer');
  const expectedCode = normalizeSetCode(expectedSourceSetCode);

  const scopedProducts = products.filter((product) => product?.sourceName === 'cardmarket' && expansionId(product) === id);
  if (!scopedProducts.length) throw new Error(`Cardmarket expansion ${id} contains no catalogue products`);

  const diagnostics = scopedProducts.map((product) => {
    const parsed = parseCardmarketSingleProductName(product.name);
    if (expectedCode && normalizeSetCode(parsed?.sourceSetCode) !== expectedCode) {
      return Object.freeze({
        sourceRecordId: product.sourceRecordId,
        sourceExpansionId: id,
        productName: product.name,
        sourceIdentity: parsed,
        status: 'unresolved',
        reason: parsed ? 'source_set_code_mismatch' : 'cardmarket_structured_identity_unavailable',
        candidates: Object.freeze([]),
        autoMappable: false,
      });
    }
    const crosswalk = findCardmarketCrosswalkCandidates(product, verifiedSetCards);
    return Object.freeze({
      sourceRecordId: product.sourceRecordId,
      sourceExpansionId: id,
      productName: product.name,
      sourceIdentity: crosswalk.sourceIdentity ?? parsed,
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
    expectedSourceSetCode: expectedCode || null,
    approvedExpansionScopeRequired: true,
    writesPerformed: false,
    counts: Object.freeze({
      ...counts,
      candidateCoverage: ratio(
        counts.exactUniquePrintingCandidates + counts.variantConfirmationRequired,
        counts.sourceProducts,
      ),
    }),
    reasons: Object.freeze(reasons),
    diagnostics: Object.freeze(diagnostics),
  });
}
