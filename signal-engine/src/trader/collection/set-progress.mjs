const VERIFIED = 'verified';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numericCollectorNumber(value) {
  const raw = text(value);
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function compareCards(a, b) {
  const aNum = numericCollectorNumber(a.collectorNumber);
  const bNum = numericCollectorNumber(b.collectorNumber);
  if (aNum != null && bNum != null && aNum !== bNum) return aNum - bNum;
  if (aNum != null && bNum == null) return -1;
  if (aNum == null && bNum != null) return 1;
  return text(a.collectorNumber).localeCompare(text(b.collectorNumber), undefined, { numeric: true })
    || text(a.name).localeCompare(text(b.name))
    || text(a.fateCardId ?? a.id).localeCompare(text(b.fateCardId ?? b.id));
}

function preferredRepresentative(cards, { preferredLanguageCode = null, preferredVariantCode = 'standard' } = {}) {
  const language = text(preferredLanguageCode).toLowerCase();
  const variant = text(preferredVariantCode).toLowerCase();
  return [...cards].sort((a, b) => {
    const aLanguage = language && text(a.languageCode).toLowerCase() === language ? 1 : 0;
    const bLanguage = language && text(b.languageCode).toLowerCase() === language ? 1 : 0;
    if (aLanguage !== bLanguage) return bLanguage - aLanguage;
    const aVariant = variant && text(a.variantCode).toLowerCase() === variant ? 1 : 0;
    const bVariant = variant && text(b.variantCode).toLowerCase() === variant ? 1 : 0;
    if (aVariant !== bVariant) return bVariant - aVariant;
    return compareCards(a, b);
  })[0] ?? null;
}

function publicMissingCard(card) {
  if (!card) return null;
  return Object.freeze({
    fateCardId: card.fateCardId ?? card.id,
    printingId: card.printingId,
    setId: card.setId,
    setName: card.setName ?? null,
    tcgCode: card.tcgCode ?? null,
    name: card.name ?? null,
    collectorNumber: card.collectorNumber,
    rarity: card.rarity ?? null,
    variantCode: card.variantCode ?? null,
    languageCode: card.languageCode ?? null,
  });
}

/**
 * Compute simple set completion from verified canonical catalogue cards.
 *
 * V1 completion is printing-scoped: owning any verified identity for a printing
 * completes that checklist slot. Language/finish variants therefore do not
 * inflate a 1..N set checklist. Distinct canonical printings remain distinct.
 */
export function computeCollectionSetProgress({
  set,
  canonicalCards,
  collectionItems,
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
} = {}) {
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  const setId = text(set.id);
  if (!setId) throw new TypeError('set.id is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');

  const tcgCode = text(set.tcgCode).toLowerCase() || null;
  const verifiedCards = canonicalCards
    .filter((card) => card && card.verificationStatus === VERIFIED)
    .filter((card) => text(card.setId) === setId)
    .filter((card) => !tcgCode || text(card.tcgCode).toLowerCase() === tcgCode)
    .filter((card) => text(card.printingId) && text(card.fateCardId ?? card.id));

  const printings = new Map();
  const cardToPrinting = new Map();
  for (const card of verifiedCards) {
    const printingId = text(card.printingId);
    const fateCardId = text(card.fateCardId ?? card.id);
    if (!printings.has(printingId)) printings.set(printingId, []);
    printings.get(printingId).push(card);
    cardToPrinting.set(fateCardId, printingId);
  }

  if (printings.size === 0) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'canonical_set_checklist_unavailable',
      tcgCode,
      setId,
      setName: set.name ?? null,
      checklistScope: 'printing',
      totalCount: null,
      ownedCount: null,
      missingCount: null,
      completionPercent: null,
      missingCards: Object.freeze([]),
    });
  }

  const ownedPrintingIds = new Set();
  for (const item of collectionItems) {
    if (!item || item.status === 'removed' || Number(item.quantity ?? 1) <= 0) continue;
    const printingId = cardToPrinting.get(text(item.fateCardId));
    if (printingId) ownedPrintingIds.add(printingId);
  }

  const missingCards = [...printings.entries()]
    .filter(([printingId]) => !ownedPrintingIds.has(printingId))
    .map(([, identities]) => preferredRepresentative(identities, { preferredLanguageCode, preferredVariantCode }))
    .filter(Boolean)
    .sort(compareCards)
    .map(publicMissingCard);

  const totalCount = printings.size;
  const ownedCount = ownedPrintingIds.size;
  const missingCount = totalCount - ownedCount;
  const completionPercent = Number(((ownedCount / totalCount) * 100).toFixed(1));

  return Object.freeze({
    status: 'available',
    reason: null,
    tcgCode,
    setId,
    setName: set.name ?? null,
    checklistScope: 'printing',
    totalCount,
    ownedCount,
    missingCount,
    completionPercent,
    missingCards: Object.freeze(missingCards),
  });
}
