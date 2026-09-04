import { normaliseCollectorNumber } from '../card-identity.mjs';
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
  return `fallback:${normaliseCollectorNumber(card.collectorNumber)}:${normaliseComparableName(card.name)}`;
}

export function parseCardmarketSingleProductName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;

  // Cardmarket's official Pokémon singles catalogue commonly encodes the
  // provider set code and collector number as a final parenthetical suffix,
  // e.g. `Bulbasaur (MEW 001)`. Parse only that explicit structure; do not
  // infer/fuzz names or numbers when the source string does not provide it.
  const match = /^(.+?)\s+\(([^()\s]+)\s+([^()]+)\)$/.exec(text);
  if (!match) return null;

  const cardName = match[1].trim();
  const sourceSetCode = match[2].trim();
  const collectorRaw = match[3].trim();
  if (!cardName || !sourceSetCode || !collectorRaw) return null;

  let collectorNumber;
  try {
    collectorNumber = normaliseCollectorNumber(collectorRaw);
  } catch {
    return null;
  }

  return Object.freeze({
    cardName,
    sourceSetCode,
    sourceCollectorNumber: collectorRaw,
    collectorNumber,
  });
}

export function cardmarketStructuredPrintingKey(product) {
  requireObject(product, 'product');
  const parsed = parseCardmarketSingleProductName(product.name);
  if (!parsed) return null;
  return `${parsed.collectorNumber}|${normaliseComparableName(parsed.cardName)}`;
}

export function findCardmarketCrosswalkCandidates(product, verifiedSetCards) {
  requireObject(product, 'product');
  requireArray(verifiedSetCards, 'verifiedSetCards');
  if (product.sourceName !== 'cardmarket') {
    throw new TypeError('product must be Cardmarket catalogue evidence');
  }

  const parsed = parseCardmarketSingleProductName(product.name);
  if (!parsed) {
    return Object.freeze({
      status: 'unresolved',
      reason: 'cardmarket_structured_identity_unavailable',
      sourceRecordId: product.sourceRecordId,
      candidates: Object.freeze([]),
      autoMappable: false,
    });
  }

  const productName = normaliseComparableName(parsed.cardName);
  const cards = verifiedSetCards.filter((card) => {
    if (!card || card.verificationStatus !== 'verified' || typeof card.name !== 'string') return false;
    let collectorNumber;
    try {
      collectorNumber = normaliseCollectorNumber(card.collectorNumber);
    } catch {
      return false;
    }
    return collectorNumber === parsed.collectorNumber
      && normaliseComparableName(card.name) === productName;
  });

  const sourceIdentity = Object.freeze({
    sourceSetCode: parsed.sourceSetCode,
    sourceCollectorNumber: parsed.sourceCollectorNumber,
    collectorNumber: parsed.collectorNumber,
    cardName: parsed.cardName,
  });

  if (cards.length === 0) {
    return Object.freeze({
      status: 'unresolved',
      reason: 'no_exact_name_and_collector_number_in_verified_set',
      sourceRecordId: product.sourceRecordId,
      sourceIdentity,
      candidates: Object.freeze([]),
      autoMappable: false,
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
      reason: 'same_name_and_number_multiple_verified_printings',
      sourceRecordId: product.sourceRecordId,
      sourceIdentity,
      printingGroups,
      candidates: Object.freeze(cards.map(compactCandidate)),
      autoMappable: false,
    });
  }

  const candidates = printingGroups[0].candidates;
  if (candidates.length > 1) {
    return Object.freeze({
      status: 'candidate',
      reason: 'printing_identified_variant_confirmation_required',
      sourceRecordId: product.sourceRecordId,
      sourceIdentity,
      printingGroups,
      candidates,
      autoMappable: false,
    });
  }

  return Object.freeze({
    status: 'candidate',
    reason: 'exact_name_and_collector_number_unique_manual_confirmation_required',
    sourceRecordId: product.sourceRecordId,
    sourceIdentity,
    printingGroups,
    candidates,
    autoMappable: false,
  });
}
