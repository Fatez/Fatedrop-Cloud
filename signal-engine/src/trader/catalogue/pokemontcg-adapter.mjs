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

function parsePokemonTcgDate(value, field) {
  const text = requireText(value, field).replaceAll('/', '-');
  const millis = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(millis)) throw new TypeError(`${field} is invalid`);
  return millis;
}

export function adaptPokemonTcgSet(set) {
  requireObject(set, 'set');

  return Object.freeze({
    sourceName: 'pokemontcg-api',
    sourceRecordId: requireText(set.id, 'set.id'),
    tcgCode: 'pokemon',
    languageCode: 'en',
    seriesName: requireText(set.series, 'set.series'),
    setName: requireText(set.name, 'set.name'),
    sourceSetCode: requireText(set.id, 'set.id'),
    printedTotal: Number.isInteger(set.printedTotal) ? set.printedTotal : null,
    total: Number.isInteger(set.total) ? set.total : null,
    releasedAt: set.releaseDate ? parsePokemonTcgDate(set.releaseDate, 'set.releaseDate') : null,
    sourceUrl: `https://api.pokemontcg.io/v2/sets/${encodeURIComponent(set.id)}`,
  });
}

export function adaptPokemonTcgCardEvidence(card) {
  requireObject(card, 'card');
  const set = requireObject(card.set, 'card.set');

  return Object.freeze({
    sourceName: 'pokemontcg-api',
    sourceRecordId: requireText(card.id, 'card.id'),
    tcgCode: 'pokemon',
    languageCode: 'en',
    seriesName: requireText(set.series, 'card.set.series'),
    setName: requireText(set.name, 'card.set.name'),
    sourceSetCode: requireText(set.id, 'card.set.id'),
    collectorNumber: requireText(card.number, 'card.number'),
    printingCode: 'main',
    name: requireText(card.name, 'card.name'),
    rarity: card.rarity ? String(card.rarity).trim() : null,
    supertype: card.supertype ? String(card.supertype).trim() : null,
    subtypes: Array.isArray(card.subtypes) ? Object.freeze([...card.subtypes]) : Object.freeze([]),
    nationalDexNumbers: Array.isArray(card.nationalPokedexNumbers)
      ? Object.freeze([...card.nationalPokedexNumbers])
      : Object.freeze([]),
    variantEvidenceAvailable: false,
    sourceUrl: `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(card.id)}`,
  });
}
