import { selectPreferredPrintingRepresentative } from '../collection/set-progress.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

/**
 * Convert exact-identity Fate Prices into one value per canonical printing slot.
 *
 * This deliberately prices only the chosen checklist representative. If the
 * requested language/variant representative has no Fate Price, the printing is
 * left unpriced; another finish/language is never substituted merely to fill a
 * coverage gap.
 */
export function buildChecklistPrintingValues({
  setId,
  canonicalCards,
  fatePrices,
  currencyCode,
  preferredLanguageCode,
  preferredVariantCode = 'standard',
} = {}) {
  const canonicalSetId = text(setId);
  if (!canonicalSetId) throw new TypeError('setId is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (!Array.isArray(fatePrices)) throw new TypeError('fatePrices must be an array');
  const code = currency(currencyCode);
  const language = text(preferredLanguageCode).toLowerCase();
  if (!language) throw new TypeError('preferredLanguageCode is required for checklist valuation');
  const variant = text(preferredVariantCode).toLowerCase();
  if (!variant) throw new TypeError('preferredVariantCode is required for checklist valuation');

  const byPrinting = new Map();
  for (const card of canonicalCards) {
    if (!card || card.verificationStatus !== 'verified' || text(card.setId) !== canonicalSetId) continue;
    const printingId = text(card.printingId);
    const fateCardId = text(card.fateCardId ?? card.id);
    if (!printingId || !fateCardId) continue;
    if (!byPrinting.has(printingId)) byPrinting.set(printingId, []);
    byPrinting.get(printingId).push(card);
  }

  const pricesByCard = new Map();
  for (const price of fatePrices) {
    if (!price || price.status !== 'available' || price.valuationKind !== 'raw-market') continue;
    const fateCardId = text(price.fateCardId ?? price.cardIdentityId);
    if (!fateCardId || currency(price.currencyCode) !== code) continue;
    pricesByCard.set(fateCardId, price);
  }

  const printingValues = [];
  const representatives = [];
  const unpricedRepresentatives = [];

  for (const [printingId, identities] of byPrinting) {
    const representative = selectPreferredPrintingRepresentative(identities, {
      preferredLanguageCode: language,
      preferredVariantCode: variant,
    });
    if (!representative) continue;

    const representativeLanguage = text(representative.languageCode).toLowerCase();
    const representativeVariant = text(representative.variantCode).toLowerCase();
    const fateCardId = text(representative.fateCardId ?? representative.id);
    const descriptor = Object.freeze({
      printingId,
      fateCardId,
      languageCode: representativeLanguage || null,
      variantCode: representativeVariant || null,
    });
    representatives.push(descriptor);

    // Language and finish are explicit valuation contracts, not hints. If the
    // canonical catalogue lacks either preferred identity dimension for this
    // printing, leave it unpriced rather than borrowing another market lane.
    if (representativeLanguage !== language) {
      unpricedRepresentatives.push(Object.freeze({ ...descriptor, reason: 'preferred_language_unavailable' }));
      continue;
    }
    if (representativeVariant !== variant) {
      unpricedRepresentatives.push(Object.freeze({ ...descriptor, reason: 'preferred_variant_unavailable' }));
      continue;
    }

    const price = pricesByCard.get(fateCardId);
    if (!price) {
      unpricedRepresentatives.push(Object.freeze({ ...descriptor, reason: 'fate_price_unavailable' }));
      continue;
    }

    printingValues.push(Object.freeze({
      printingId,
      fateCardId,
      amount: price.amount,
      currencyCode: code,
      observedAt: price.sourceEffectiveAt ?? price.observedAt,
      sourceName: price.sourceName,
      providerPolicyKey: price.providerPolicyKey,
      metricUsed: price.metricUsed,
      confidence: price.confidence,
    }));
  }

  return Object.freeze({
    setId: canonicalSetId,
    currencyCode: code,
    preferredLanguageCode: language,
    preferredVariantCode: variant,
    printingValues: Object.freeze(printingValues),
    representatives: Object.freeze(representatives),
    unpricedRepresentatives: Object.freeze(unpricedRepresentatives),
  });
}
