export const CARDMARKET_PRODUCT_SOURCE = 'cardmarket';
export const CARDMARKET_POKEMON_SINGLES_FILE = 'products_singles_6.json';

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

function requirePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function optionalPositiveInteger(value, field) {
  if (value == null || value === '') return null;
  return requirePositiveInteger(value, field);
}

function optionalText(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function normaliseDateAdded(value) {
  const text = optionalText(value);
  if (!text || text.startsWith('0000-00-00')) return null;
  const millis = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isFinite(millis) ? millis : null;
}

export function extractCardmarketCatalogueRows(payload) {
  if (Array.isArray(payload)) return payload;
  requireObject(payload, 'catalogue');
  for (const key of ['products', 'data', 'items']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  throw new TypeError('Cardmarket catalogue records array was not found');
}

export function adaptCardmarketCatalogueProduct(row, {
  sourceFile = CARDMARKET_POKEMON_SINGLES_FILE,
} = {}) {
  requireObject(row, 'row');
  const sourceRecordId = String(requirePositiveInteger(row.idProduct, 'row.idProduct'));

  // Catalogue evidence is intentionally NOT a FateDrop card identity. The
  // public product catalogue does not, by itself, prove FateDrop's exact
  // set/collector-number/finish/language identity. Crosswalk reconciliation
  // must happen separately and may leave this record unresolved.
  return Object.freeze({
    sourceName: CARDMARKET_PRODUCT_SOURCE,
    sourceRecordId,
    name: requireText(row.name, 'row.name'),
    sourceCategoryId: optionalPositiveInteger(row.idCategory, 'row.idCategory'),
    sourceCategoryName: optionalText(row.categoryName),
    sourceExpansionId: optionalPositiveInteger(row.idExpansion, 'row.idExpansion'),
    sourceMetacardId: optionalPositiveInteger(row.idMetacard, 'row.idMetacard'),
    sourceDateAdded: normaliseDateAdded(row.dateAdded),
    sourceFile: requireText(sourceFile, 'sourceFile'),
    rawPayload: Object.freeze({ ...row }),
  });
}

export function adaptCardmarketCatalogue(payload, options = {}) {
  const rows = extractCardmarketCatalogueRows(payload);
  if (rows.length === 0) throw new TypeError('Cardmarket catalogue contained zero records');
  return Object.freeze(rows.map((row) => adaptCardmarketCatalogueProduct(row, options)));
}
