import fs from 'node:fs';
import path from 'node:path';

import { normaliseComparableName } from '../catalogue/reconcile.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cardmarketComparableName(value) {
  return normaliseComparableName(
    text(value)
      .replace(/♀/g, ' female ')
      .replace(/♂/g, ' male '),
  );
}

function cardmarketProductNameMatch(productName, cardName) {
  const canonical = cardmarketComparableName(cardName);
  const raw = text(productName);
  let candidate = raw
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i, 'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i, 'Nidoran male');
  const providerAliasApplied = candidate !== raw;

  if (cardmarketComparableName(candidate) === canonical) {
    return providerAliasApplied ? 'provider_disambiguation_suffix' : 'exact_name';
  }

  // Cardmarket appends provider-only square-bracket descriptors to many
  // Pokémon product names (attacks, abilities and similar disambiguators),
  // e.g. `Bulbasaur [Leech Seed | 151]`. They are not part of the printed
  // card name. Strip only trailing bracket groups and still require the
  // remaining provider name to equal the canonical card name exactly.
  const trailingDescriptor = /\s+\[[^[\]]+\]\s*$/;
  while (trailingDescriptor.test(candidate)) {
    candidate = candidate.replace(trailingDescriptor, '').trim();
    if (candidate && cardmarketComparableName(candidate) === canonical) {
      return 'provider_disambiguation_suffix';
    }
  }

  return null;
}

function listFilesRecursive(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
    }
  }
  files.sort();
  return files;
}

function findBalancedEnd(source, start, openChar, closeChar) {
  if (source[start] !== openChar) return -1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function balancedAfter(source, regex, openChar, closeChar) {
  const match = regex.exec(source);
  if (!match) return null;
  const start = source.indexOf(openChar, match.index + match[0].length - 1);
  if (start < 0) return null;
  const end = findBalancedEnd(source, start, openChar, closeChar);
  return end < 0 ? null : source.slice(start, end + 1);
}

function objectProperty(source, property) {
  return balancedAfter(source, new RegExp(`\\b${property}\\s*:\\s*\\{`), '{', '}');
}

function arrayProperty(source, property) {
  return balancedAfter(source, new RegExp(`\\b${property}\\s*:\\s*\\[`), '[', ']');
}

function quotedProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);
  return match ? match[2].trim() : null;
}

function integerProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(\\d+)`).exec(source);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function topLevelObjects(arraySource) {
  if (!arraySource || arraySource[0] !== '[') return [];
  const rows = [];
  let index = 1;
  while (index < arraySource.length - 1) {
    const open = arraySource.indexOf('{', index);
    if (open < 0) break;
    const end = findBalancedEnd(arraySource, open, '{', '}');
    if (end < 0) break;
    rows.push(arraySource.slice(open, end + 1));
    index = end + 1;
  }
  return rows;
}

function stringArray(source, property) {
  const block = arrayProperty(source, property);
  if (!block) return [];
  const values = [];
  const regex = /["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(block))) values.push(match[1].trim());
  return values;
}

function parseReleaseDate(source) {
  const direct = quotedProperty(source, 'releaseDate');
  if (direct) return direct;
  const block = objectProperty(source, 'releaseDate');
  return quotedProperty(block, 'en');
}

export function parseTcgdexSetSource(filePath, source, dataRoot) {
  if (!/:\s*Set\s*=\s*\{/.test(source)) return null;
  const root = balancedAfter(source, /:\s*Set\s*=\s*\{/, '{', '}');
  if (!root) return null;
  const id = quotedProperty(root, 'id');
  const name = quotedProperty(objectProperty(root, 'name'), 'en');
  if (!id || !name) return null;
  const relative = path.relative(dataRoot, filePath);
  const seriesName = relative.split(path.sep)[0] || null;
  const thirdParty = objectProperty(root, 'thirdParty');
  const abbreviations = objectProperty(root, 'abbreviations');
  const cardCount = objectProperty(root, 'cardCount');
  const cardDirectory = filePath.slice(0, -3);
  return Object.freeze({
    tcgdexSetId: id,
    setName: name,
    seriesName,
    releaseDate: parseReleaseDate(root),
    officialCardCount: integerProperty(cardCount, 'official'),
    officialAbbreviation: quotedProperty(abbreviations, 'official'),
    cardmarketExpansionId: integerProperty(thirdParty, 'cardmarket'),
    sourcePath: relative.split(path.sep).join('/'),
    cardDirectory: fs.existsSync(cardDirectory) && fs.statSync(cardDirectory).isDirectory() ? cardDirectory : null,
  });
}

export function parseTcgdexCardSource(filePath, source, setId) {
  if (!/:\s*Card\s*=\s*\{/.test(source)) return null;
  const root = balancedAfter(source, /:\s*Card\s*=\s*\{/, '{', '}');
  if (!root) return null;
  const name = quotedProperty(objectProperty(root, 'name'), 'en');
  if (!name) return null;
  const localId = path.basename(filePath, '.ts');
  const variantsSource = arrayProperty(root, 'variants');
  const variants = topLevelObjects(variantsSource).map((variant, index) => {
    const thirdParty = objectProperty(variant, 'thirdParty');
    const stamp = stringArray(variant, 'stamp');
    return Object.freeze({
      index,
      type: quotedProperty(variant, 'type'),
      subtype: quotedProperty(variant, 'subtype'),
      foil: quotedProperty(variant, 'foil'),
      stamp: Object.freeze(stamp),
      cardmarketProductId: integerProperty(thirdParty, 'cardmarket'),
    });
  });
  return Object.freeze({
    tcgdexCardId: `${setId}-${localId}`,
    localId,
    name,
    normalizedName: normaliseComparableName(name),
    variants: Object.freeze(variants),
    sourcePath: filePath,
  });
}

function loadCardsForSet(set) {
  if (!set.cardDirectory) return Object.freeze([]);
  const cards = [];
  for (const filePath of listFilesRecursive(set.cardDirectory)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const card = parseTcgdexCardSource(filePath, source, set.tcgdexSetId);
    if (card) cards.push(card);
  }
  cards.sort((left, right) => left.localId.localeCompare(right.localId, undefined, { numeric: true }));
  return Object.freeze(cards);
}

export function loadTcgdexRepositoryEvidence(repositoryRoot, { includeCards = true } = {}) {
  const root = path.resolve(text(repositoryRoot));
  if (!root || !fs.existsSync(root)) throw new Error(`TCGdex repository path does not exist: ${repositoryRoot}`);
  const dataRoot = path.join(root, 'data');
  if (!fs.existsSync(dataRoot)) throw new Error(`TCGdex repository data directory does not exist: ${dataRoot}`);
  const sets = [];
  for (const filePath of listFilesRecursive(dataRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const set = parseTcgdexSetSource(filePath, source, dataRoot);
    if (!set) continue;
    sets.push(Object.freeze({
      ...set,
      cards: includeCards ? loadCardsForSet(set) : Object.freeze([]),
    }));
  }
  sets.sort((left, right) => (left.releaseDate || '').localeCompare(right.releaseDate || '') || left.tcgdexSetId.localeCompare(right.tcgdexSetId));
  return Object.freeze({
    repositoryRoot: root,
    setCount: sets.length,
    sets: Object.freeze(sets),
    bySetId: new Map(sets.map((set) => [set.tcgdexSetId, set])),
  });
}

export function auditExplicitCardmarketMappings(set, productsById, productsByExpansion) {
  if (!set || !set.tcgdexSetId) throw new TypeError('set evidence is required');
  const expansionId = Number(set.cardmarketExpansionId);
  if (!Number.isSafeInteger(expansionId) || expansionId <= 0) {
    return Object.freeze({
      status: 'unresolved',
      reason: 'tcgdex_set_has_no_explicit_cardmarket_expansion_id',
      cardmarketExpansionId: null,
      counts: Object.freeze({ cards: set.cards.length, cardsWithVerifiedProduct: 0, variants: 0, variantsWithCardmarketId: 0, verifiedProducts: 0, missingProducts: 0, nameConflicts: 0 }),
      mappings: Object.freeze([]),
    });
  }

  const expansionProducts = productsByExpansion.get(expansionId) || [];
  if (!expansionProducts.length) {
    return Object.freeze({
      status: 'unresolved',
      reason: 'explicit_cardmarket_expansion_absent_from_official_catalogue',
      cardmarketExpansionId: expansionId,
      counts: Object.freeze({ cards: set.cards.length, cardsWithVerifiedProduct: 0, variants: 0, variantsWithCardmarketId: 0, verifiedProducts: 0, missingProducts: 0, nameConflicts: 0, officialExpansionProducts: 0 }),
      mappings: Object.freeze([]),
    });
  }

  const mappings = [];
  const cardsWithVerifiedProduct = new Set();
  const verifiedProductIds = new Set();
  let variants = 0;
  let variantsWithCardmarketId = 0;
  let missingProducts = 0;
  let nameConflicts = 0;

  for (const card of set.cards) {
    for (const variant of card.variants) {
      variants += 1;
      const productId = Number(variant.cardmarketProductId);
      if (!Number.isSafeInteger(productId) || productId <= 0) continue;
      variantsWithCardmarketId += 1;
      const product = productsById.get(productId) || null;
      if (!product) {
        missingProducts += 1;
        mappings.push(Object.freeze({
          tcgdexCardId: card.tcgdexCardId,
          localId: card.localId,
          cardName: card.name,
          variant,
          cardmarketProductId: productId,
          status: 'unresolved',
          reason: 'explicit_cardmarket_product_absent_from_official_catalogue',
        }));
        continue;
      }
      const productName = text(product.name);
      const nameMatchBasis = cardmarketProductNameMatch(productName, card.name);
      if (!nameMatchBasis) {
        nameConflicts += 1;
        mappings.push(Object.freeze({
          tcgdexCardId: card.tcgdexCardId,
          localId: card.localId,
          cardName: card.name,
          variant,
          cardmarketProductId: productId,
          cardmarketProductName: productName,
          cardmarketExpansionId: product.sourceExpansionId ?? null,
          status: 'conflict',
          reason: 'explicit_product_id_name_conflicts_with_tcgdex_card',
        }));
        continue;
      }
      cardsWithVerifiedProduct.add(card.tcgdexCardId);
      verifiedProductIds.add(productId);
      mappings.push(Object.freeze({
        tcgdexCardId: card.tcgdexCardId,
        localId: card.localId,
        cardName: card.name,
        variant,
        cardmarketProductId: productId,
        cardmarketProductName: productName,
        cardmarketExpansionId: product.sourceExpansionId ?? null,
        expansionRelation: Number(product.sourceExpansionId) === expansionId ? 'main_set_expansion' : 'supplemental_cardmarket_expansion',
        nameMatchBasis,
        status: 'proven',
        reason: 'tcgdex_explicit_cardmarket_product_id_verified_in_official_catalogue',
      }));
    }
  }

  const ratio = (numerator, denominator) => denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
  return Object.freeze({
    status: 'proven',
    reason: 'tcgdex_explicit_cardmarket_expansion_id_verified_in_official_catalogue',
    cardmarketExpansionId: expansionId,
    counts: Object.freeze({
      cards: set.cards.length,
      officialCardCount: set.officialCardCount,
      cardsWithVerifiedProduct: cardsWithVerifiedProduct.size,
      cardProductCoverage: ratio(cardsWithVerifiedProduct.size, set.cards.length),
      variants,
      variantsWithCardmarketId,
      variantIdCoverage: ratio(variantsWithCardmarketId, variants),
      verifiedProducts: verifiedProductIds.size,
      missingProducts,
      nameConflicts,
      officialExpansionProducts: expansionProducts.length,
      verifiedProductToExpansionProductCoverage: ratio(
        [...verifiedProductIds].filter((id) => Number(productsById.get(id)?.sourceExpansionId) === expansionId).length,
        expansionProducts.length,
      ),
    }),
    mappings: Object.freeze(mappings),
  });
}

export function indexCardmarketProducts(products) {
  if (!Array.isArray(products)) throw new TypeError('products must be an array');
  const byId = new Map();
  const byExpansion = new Map();
  for (const product of products) {
    const id = Number(product?.sourceRecordId);
    const expansionId = Number(product?.sourceExpansionId);
    if (Number.isSafeInteger(id) && id > 0) byId.set(id, product);
    if (Number.isSafeInteger(expansionId) && expansionId > 0) {
      const rows = byExpansion.get(expansionId) || [];
      rows.push(product);
      byExpansion.set(expansionId, rows);
    }
  }
  return Object.freeze({ byId, byExpansion });
}
