function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} is required`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

export function createTcgdexSnapshotClient(snapshot) {
  const root = requireObject(snapshot, 'tcgdex snapshot');
  const sets = requireObject(root.sets, 'tcgdex snapshot.sets');
  const cards = requireObject(root.cards, 'tcgdex snapshot.cards');
  const series = requireObject(root.series, 'tcgdex snapshot.series');

  return Object.freeze({
    snapshotMeta: Object.freeze({ ...(root.meta || {}) }),
    async listSets() {
      return Object.values(sets).map((set) => ({ id: set.id, name: set.name }));
    },
    async getSeries(id) {
      const key = requireText(id, 'seriesId');
      const found = series[key];
      if (!found) throw new Error(`TCGdex snapshot series not found: ${key}`);
      return found;
    },
    async getSet(id) {
      const key = requireText(id, 'setId');
      const found = sets[key];
      if (!found) throw new Error(`TCGdex snapshot set not found: ${key}`);
      return found;
    },
    async getCard(id) {
      const key = requireText(id, 'cardId');
      const found = cards[key];
      if (!found) throw new Error(`TCGdex snapshot card not found: ${key}`);
      return found;
    },
  });
}

export function createPokemonTcgSnapshotClient(snapshot) {
  const root = requireObject(snapshot, 'pokemon snapshot');
  const sets = requireArray(root.sets, 'pokemon snapshot.sets');
  const cardsBySet = requireObject(root.cardsBySet, 'pokemon snapshot.cardsBySet');
  const setIndex = new Map(sets.map((set) => [String(set?.id || ''), set]));
  const cardIndex = new Map();
  for (const rows of Object.values(cardsBySet)) {
    for (const card of requireArray(rows, 'pokemon snapshot card set')) {
      if (card?.id) cardIndex.set(String(card.id), card);
    }
  }

  return Object.freeze({
    snapshotMeta: Object.freeze({ ...(root.meta || {}) }),
    async listSets() {
      return sets;
    },
    async getSet(id) {
      const key = requireText(id, 'setId');
      const found = setIndex.get(key);
      if (!found) throw new Error(`Pokémon snapshot set not found: ${key}`);
      return found;
    },
    async listCardsBySet(setId) {
      const key = requireText(setId, 'setId');
      return cardsBySet[key] ? [...cardsBySet[key]] : [];
    },
    async getCard(id) {
      const key = requireText(id, 'cardId');
      const found = cardIndex.get(key);
      if (!found) throw new Error(`Pokémon snapshot card not found: ${key}`);
      return found;
    },
  });
}
