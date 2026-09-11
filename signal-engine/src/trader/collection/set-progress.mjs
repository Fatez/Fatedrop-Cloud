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

export function selectPreferredPrintingRepresentative(cards, {
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
} = {}) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
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
  const fateCardId = text(card.fateCardId);
  return Object.freeze({
    fateCardId: fateCardId || null,
    printingId: card.printingId ?? card.id,
    setId: card.setId,
    setName: card.setName ?? null,
    tcgCode: card.tcgCode ?? null,
    name: card.name ?? null,
    collectorNumber: card.collectorNumber,
    rarity: card.rarity ?? null,
    variantCode: card.variantCode ?? null,
    languageCode: card.languageCode ?? null,
    thumbnailUrl: card.thumbnailUrl ?? null,
    identityStatus: fateCardId ? 'verified_exact_identity' : 'printing_only_finish_or_edition_unresolved',
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
  canonicalPrintings = null,
  collectionItems,
  assertedPrintingIds = [],
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
} = {}) {
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  const setId = text(set.id);
  if (!setId) throw new TypeError('set.id is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (canonicalPrintings != null && !Array.isArray(canonicalPrintings)) throw new TypeError('canonicalPrintings must be an array when provided');
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');
  if (!Array.isArray(assertedPrintingIds)) throw new TypeError('assertedPrintingIds must be an array');

  const tcgCode = text(set.tcgCode).toLowerCase() || null;
  const verifiedCards = canonicalCards
    .filter((card) => card && card.verificationStatus === VERIFIED)
    .filter((card) => text(card.setId) === setId)
    .filter((card) => !tcgCode || text(card.tcgCode).toLowerCase() === tcgCode)
    .filter((card) => text(card.printingId) && text(card.fateCardId ?? card.id));

  const printings = new Map();
  const identitiesByPrinting = new Map();
  const cardToPrinting = new Map();
  for (const card of verifiedCards) {
    const printingId = text(card.printingId);
    const fateCardId = text(card.fateCardId ?? card.id);
    if (!identitiesByPrinting.has(printingId)) identitiesByPrinting.set(printingId, []);
    identitiesByPrinting.get(printingId).push(card);
    cardToPrinting.set(fateCardId, printingId);
  }
  if (canonicalPrintings != null) {
    for (const printing of canonicalPrintings) {
      if (!printing || printing.verificationStatus !== VERIFIED || text(printing.setId) !== setId) continue;
      const printingId = text(printing.printingId ?? printing.id);
      if (!printingId) continue;
      printings.set(printingId, { ...printing, printingId });
    }
  } else {
    for (const [printingId, identities] of identitiesByPrinting) {
      const representative = selectPreferredPrintingRepresentative(identities, { preferredLanguageCode, preferredVariantCode });
      if (representative) printings.set(printingId, representative);
    }
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
      exactOwnedCount: null,
      userConfirmedCount: null,
      exactIdentityConfirmationNeededCount: null,
      missingCount: null,
      completionPercent: null,
      missingCards: Object.freeze([]),
    });
  }

  const ownedPrintingIds = new Set();
  for (const item of collectionItems) {
    if (!item || item.status === 'removed' || Number(item.quantity ?? 1) <= 0) continue;
    if (String(item.copyState || 'raw').toLowerCase() !== 'raw') continue;
    const printingId = cardToPrinting.get(text(item.fateCardId));
    if (printingId) ownedPrintingIds.add(printingId);
  }

  const userConfirmedPrintingIds = new Set(
    assertedPrintingIds
      .map(text)
      .filter((printingId) => printings.has(printingId)),
  );
  const completedPrintingIds = new Set([...ownedPrintingIds, ...userConfirmedPrintingIds]);
  const assertedOnlyPrintingIds = new Set(
    [...userConfirmedPrintingIds].filter((printingId) => !ownedPrintingIds.has(printingId)),
  );

  const missingCards = [...printings.entries()]
    .filter(([printingId]) => !completedPrintingIds.has(printingId))
    .map(([printingId, printing]) => (
      selectPreferredPrintingRepresentative(identitiesByPrinting.get(printingId) || [], { preferredLanguageCode, preferredVariantCode })
      || printing
    ))
    .filter(Boolean)
    .sort(compareCards)
    .map(publicMissingCard);

  const totalCount = printings.size;
  const ownedCount = completedPrintingIds.size;
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
    exactOwnedCount: ownedPrintingIds.size,
    userConfirmedCount: userConfirmedPrintingIds.size,
    exactIdentityConfirmationNeededCount: assertedOnlyPrintingIds.size,
    missingCount,
    completionPercent,
    missingCards: Object.freeze(missingCards),
    ownershipPolicy: 'exact_identity_or_user_confirmed_printing',
    valuationPolicy: 'exact_identity_only',
  });
}
