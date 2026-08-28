import { normaliseComparableName } from '../catalogue/reconcile.mjs';

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

function compactCandidate(card) {
  return Object.freeze({
    fateCardId: card.fateCardId ?? card.id,
    printingId: card.printingId ?? null,
    name: card.name,
    collectorNumber: card.collectorNumber,
    variantCode: card.variantCode,
    languageCode: card.languageCode,
    verificationStatus: card.verificationStatus,
  });
}

function groupPrintingKey(card) {
  if (card.printingId) return `printing:${card.printingId}`;
  return `fallback:${card.collectorNumber ?? ''}:${card.name ?? ''}`;
}

export function findCardmarketCrosswalkCandidates(product, verifiedSetCards) {
  requireObject(product, 'product');
  requireArray(verifiedSetCards, 'verifiedSetCards');
  if (product.sourceName !== 'cardmarket') {
    throw new TypeError('product must be Cardmarket catalogue evidence');
  }

  const productName = normaliseComparableName(product.name);
  const cards = verifiedSetCards.filter((card) => (
    card
    && card.verificationStatus === 'verified'
    && typeof card.name === 'string'
    && normaliseComparableName(card.name) === productName
  ));

  if (cards.length === 0) {
    return Object.freeze({
      status: 'unresolved',
      reason: 'no_exact_name_in_verified_set',
      sourceRecordId: product.sourceRecordId,
      candidates: Object.freeze([]),
    });
  }

  const byPrinting = new Map();
  for (const card of cards) {
    const key = groupPrintingKey(card);
    const existing = byPrinting.get(key) || [];
    existing.push(compactCandidate(card));
    byPrinting.set(key, existing);
  }

  const printingGroups = Object.freeze([...byPrinting.entries()].map(([key, candidates]) => Object.freeze({
    key,
    candidates: Object.freeze(candidates),
  })));

  if (printingGroups.length > 1) {
    return Object.freeze({
      status: 'ambiguous',
      reason: 'same_name_multiple_verified_printings',
      sourceRecordId: product.sourceRecordId,
      printingGroups,
      candidates: Object.freeze(cards.map(compactCandidate)),
    });
  }

  const candidates = printingGroups[0].candidates;
  if (candidates.length > 1) {
    return Object.freeze({
      status: 'candidate',
      reason: 'printing_identified_variant_confirmation_required',
      sourceRecordId: product.sourceRecordId,
      printingGroups,
      candidates,
      autoMappable: false,
    });
  }

  return Object.freeze({
    status: 'candidate',
    reason: 'exact_name_unique_in_verified_set_manual_confirmation_required',
    sourceRecordId: product.sourceRecordId,
    printingGroups,
    candidates,
    autoMappable: false,
  });
}
