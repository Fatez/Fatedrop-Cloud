function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function parseDateToEpoch(value, field) {
  const text = requireText(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new TypeError(`${field} is invalid`);
  return millis;
}

export function adaptTcgdexSet(set, { languageCode = 'en' } = {}) {
  requireObject(set, 'set');
  const serie = requireObject(set.serie, 'set.serie');
  const cardCount = requireObject(set.cardCount, 'set.cardCount');

  return Object.freeze({
    sourceName: 'tcgdex',
    sourceRecordId: requireText(set.id, 'set.id'),
    languageCode: requireText(languageCode, 'languageCode').toLowerCase(),
    tcgCode: 'pokemon',
    sourceSeriesCode: requireText(serie.id, 'set.serie.id'),
    seriesName: requireText(serie.name, 'set.serie.name'),
    sourceSetCode: requireText(set.id, 'set.id'),
    setName: requireText(set.name, 'set.name'),
    printedTotal: Number.isInteger(cardCount.official) ? cardCount.official : null,
    total: Number.isInteger(cardCount.total) ? cardCount.total : null,
    releasedAt: set.releaseDate ? parseDateToEpoch(set.releaseDate, 'set.releaseDate') : null,
    sourceUrl: `https://api.tcgdex.net/v2/${encodeURIComponent(languageCode)}/sets/${encodeURIComponent(set.id)}`,
  });
}

export function extractTcgdexVariants(variants) {
  requireObject(variants, 'card.variants');

  for (const field of ['normal', 'reverse', 'holo', 'firstEdition']) {
    if (typeof variants[field] !== 'boolean') {
      throw new TypeError(`card.variants.${field} must be boolean`);
    }
  }

  // First edition is an edition dimension that can combine with a finish.
  // Until that composition is modelled explicitly, quarantine the record rather
  // than flattening it into a misleading finish-only identity.
  if (variants.firstEdition) {
    return Object.freeze({
      status: 'quarantined',
      reason: 'first_edition_variant_composition_not_supported',
      variants: Object.freeze([]),
    });
  }

  const found = [];
  if (variants.normal) found.push({ variantCode: 'standard', sourceVariantKey: 'normal' });
  if (variants.reverse) found.push({ variantCode: 'reverse-holo', sourceVariantKey: 'reverse' });
  if (variants.holo) found.push({ variantCode: 'holo', sourceVariantKey: 'holo' });
  if (variants.wPromo === true) found.push({ variantCode: 'w-promo', sourceVariantKey: 'w-promo' });

  if (found.length === 0) {
    return Object.freeze({
      status: 'quarantined',
      reason: 'no_explicit_finish_variant',
      variants: Object.freeze([]),
    });
  }

  return Object.freeze({
    status: 'staged',
    reason: null,
    variants: Object.freeze(found.map((item) => Object.freeze(item))),
  });
}

export function adaptTcgdexCard(card, { sourceSeriesCode, languageCode = 'en' } = {}) {
  requireObject(card, 'card');
  const set = requireObject(card.set, 'card.set');
  const variants = extractTcgdexVariants(card.variants);

  // Source adapters emit evidence only. They must never create FateDrop-owned
  // canonical IDs from upstream set/series identifiers.
  const baseEvidence = Object.freeze({
    sourceName: 'tcgdex',
    sourceRecordId: requireText(card.id, 'card.id'),
    tcgCode: 'pokemon',
    sourceSeriesCode: requireText(sourceSeriesCode, 'sourceSeriesCode'),
    sourceSetCode: requireText(set.id, 'card.set.id'),
    setName: requireText(set.name, 'card.set.name'),
    collectorNumber: requireText(card.localId, 'card.localId'),
    printingCode: 'main',
    name: requireText(card.name, 'card.name'),
    rarity: card.rarity ? String(card.rarity).trim() : null,
    supertype: card.category ? String(card.category).trim() : null,
    languageCode: requireText(languageCode, 'languageCode').toLowerCase(),
    variantEvidenceAvailable: variants.status === 'staged',
    sourceUrl: `https://api.tcgdex.net/v2/${encodeURIComponent(languageCode)}/cards/${encodeURIComponent(card.id)}`,
  });

  return Object.freeze({
    status: variants.status,
    reason: variants.reason,
    baseEvidence,
    variantEvidence: variants.variants,
  });
}
