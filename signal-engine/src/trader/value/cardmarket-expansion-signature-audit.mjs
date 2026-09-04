import { normaliseComparableName } from '../catalogue/reconcile.mjs';

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

function expansionId(product) {
  const value = Number(product?.sourceExpansionId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function productName(product) {
  return typeof product?.name === 'string' ? normaliseComparableName(product.name) : '';
}

function cardName(card) {
  return typeof card?.name === 'string' ? normaliseComparableName(card.name) : '';
}

function sourceCardGroupKey(product) {
  const metacard = Number(product?.sourceMetacardId);
  if (Number.isSafeInteger(metacard) && metacard > 0) return `metacard:${metacard}`;
  const record = String(product?.sourceRecordId || '').trim();
  return record ? `product:${record}` : null;
}

function safeDate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function buildCardmarketExpansionIndex(products) {
  requireArray(products, 'products');
  const groups = new Map();

  for (const product of products) {
    if (product?.sourceName !== 'cardmarket') continue;
    const id = expansionId(product);
    if (!id) continue;
    const name = productName(product);
    if (!name) continue;

    let group = groups.get(id);
    if (!group) {
      group = {
        sourceExpansionId: id,
        products: [],
        names: new Set(),
        metacardIds: new Set(),
        earliestDateAdded: null,
        latestDateAdded: null,
      };
      groups.set(id, group);
    }

    group.products.push(product);
    group.names.add(name);
    const metacard = Number(product?.sourceMetacardId);
    if (Number.isSafeInteger(metacard) && metacard > 0) group.metacardIds.add(metacard);
    const dateAdded = safeDate(product?.sourceDateAdded);
    if (dateAdded != null) {
      group.earliestDateAdded = group.earliestDateAdded == null ? dateAdded : Math.min(group.earliestDateAdded, dateAdded);
      group.latestDateAdded = group.latestDateAdded == null ? dateAdded : Math.max(group.latestDateAdded, dateAdded);
    }
  }

  const rows = [...groups.values()].map((group) => Object.freeze({
    sourceExpansionId: group.sourceExpansionId,
    sourceProductCount: group.products.length,
    sourceDistinctNameCount: group.names.size,
    sourceDistinctMetacardCount: group.metacardIds.size || null,
    earliestDateAdded: group.earliestDateAdded,
    latestDateAdded: group.latestDateAdded,
    names: group.names,
    products: Object.freeze(group.products),
  }));

  rows.sort((left, right) => left.sourceExpansionId - right.sourceExpansionId);
  return Object.freeze({
    expansionCount: rows.length,
    groups: Object.freeze(rows),
    byExpansionId: new Map(rows.map((row) => [row.sourceExpansionId, row])),
  });
}

export function buildTcgdexSetCardSignature(cards) {
  requireArray(cards, 'cards');
  const names = new Set();
  const cardsByName = new Map();
  const validCards = [];

  for (const card of cards) {
    const id = String(card?.id || '').trim();
    const localId = String(card?.localId || '').trim();
    const name = cardName(card);
    if (!id || !localId || !name) continue;
    const compact = Object.freeze({ id, localId, name: String(card.name).trim(), normalizedName: name });
    validCards.push(compact);
    names.add(name);
    const existing = cardsByName.get(name) || [];
    existing.push(compact);
    cardsByName.set(name, existing);
  }

  if (!validCards.length) throw new Error('TCGdex set contains no usable card brief evidence');
  return Object.freeze({
    cardCount: validCards.length,
    distinctNameCount: names.size,
    names,
    cards: Object.freeze(validCards),
    cardsByName,
  });
}

function countOverlap(leftNames, rightNames) {
  let overlap = 0;
  for (const name of leftNames) if (rightNames.has(name)) overlap += 1;
  return overlap;
}

function closeness(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Number((Math.min(a, b) / Math.max(a, b)).toFixed(6));
}

export function rankCardmarketExpansionNameEvidence(index, tcgdexCards, { limit = 12 } = {}) {
  if (!index || !Array.isArray(index.groups)) throw new TypeError('Cardmarket expansion index is required');
  const signature = buildTcgdexSetCardSignature(tcgdexCards);
  const rows = [];

  for (const group of index.groups) {
    const overlap = countOverlap(signature.names, group.names);
    if (!overlap) continue;
    const canonicalNameCoverage = ratio(overlap, signature.distinctNameCount);
    const sourceNamePrecision = ratio(overlap, group.sourceDistinctNameCount);
    const nameCountCloseness = closeness(signature.distinctNameCount, group.sourceDistinctNameCount) ?? 0;
    const metacardCountCloseness = closeness(signature.cardCount, group.sourceDistinctMetacardCount) ?? 0;
    const score = Number((
      canonicalNameCoverage * 0.55
      + sourceNamePrecision * 0.25
      + nameCountCloseness * 0.10
      + metacardCountCloseness * 0.10
    ).toFixed(6));

    rows.push(Object.freeze({
      sourceExpansionId: group.sourceExpansionId,
      sourceProductCount: group.sourceProductCount,
      sourceDistinctNameCount: group.sourceDistinctNameCount,
      sourceDistinctMetacardCount: group.sourceDistinctMetacardCount,
      canonicalCardCount: signature.cardCount,
      canonicalDistinctNameCount: signature.distinctNameCount,
      exactNameOverlap: overlap,
      canonicalNameCoverage,
      sourceNamePrecision,
      nameCountCloseness,
      metacardCountCloseness,
      earliestDateAdded: group.earliestDateAdded,
      latestDateAdded: group.latestDateAdded,
      score,
      status: 'evidence_only',
      approved: false,
    }));
  }

  rows.sort((left, right) => (
    right.score - left.score
    || right.canonicalNameCoverage - left.canonicalNameCoverage
    || right.sourceNamePrecision - left.sourceNamePrecision
    || right.exactNameOverlap - left.exactNameOverlap
    || left.sourceExpansionId - right.sourceExpansionId
  ));

  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
  return Object.freeze(rows.slice(0, safeLimit));
}

export function classifyCardmarketExpansionEvidence(candidates, {
  minCanonicalNameCoverage = 0.90,
  minSourceNamePrecision = 0.80,
  minScore = 0.86,
  dominanceMargin = 0.06,
  minOverlap = null,
} = {}) {
  requireArray(candidates, 'candidates');
  if (!candidates.length) {
    return Object.freeze({ status: 'unresolved', reason: 'no_cardmarket_expansion_name_overlap', sourceExpansionIds: Object.freeze([]) });
  }

  const top = candidates[0];
  const requiredOverlap = minOverlap == null
    ? Math.min(20, Math.max(5, Math.ceil(Number(top.canonicalDistinctNameCount || 0) * 0.25)))
    : Number(minOverlap);

  if (
    top.exactNameOverlap < requiredOverlap
    || top.canonicalNameCoverage < Number(minCanonicalNameCoverage)
    || top.sourceNamePrecision < Number(minSourceNamePrecision)
    || top.score < Number(minScore)
  ) {
    return Object.freeze({
      status: 'unresolved',
      reason: 'top_expansion_signature_below_proof_threshold',
      sourceExpansionIds: Object.freeze([top.sourceExpansionId]),
      topCandidate: top,
    });
  }

  const second = candidates[1] || null;
  if (second) {
    const scoreGap = top.score - second.score;
    const comparableCoverage = second.canonicalNameCoverage >= top.canonicalNameCoverage - 0.04;
    const comparablePrecision = second.sourceNamePrecision >= top.sourceNamePrecision - 0.08;
    const comparableOverlap = second.exactNameOverlap >= Math.floor(top.exactNameOverlap * 0.90);
    if (scoreGap < Number(dominanceMargin) && comparableCoverage && comparablePrecision && comparableOverlap) {
      return Object.freeze({
        status: 'ambiguous',
        reason: 'multiple_cardmarket_expansions_have_competing_set_signatures',
        sourceExpansionIds: Object.freeze([top.sourceExpansionId, second.sourceExpansionId]),
        topCandidate: top,
        runnerUp: second,
        scoreGap: Number(scoreGap.toFixed(6)),
      });
    }
  }

  return Object.freeze({
    status: 'proven',
    reason: 'dominant_exact_card_name_set_signature',
    sourceExpansionIds: Object.freeze([top.sourceExpansionId]),
    sourceExpansionId: top.sourceExpansionId,
    topCandidate: top,
    runnerUp: second,
    scoreGap: second ? Number((top.score - second.score).toFixed(6)) : null,
    proofScope: 'set_expansion_only',
    productVariantIdentityProven: false,
  });
}

export function auditCardmarketCanonicalCardCoverage(index, tcgdexCards, sourceExpansionId) {
  if (!index?.byExpansionId || typeof index.byExpansionId.get !== 'function') {
    throw new TypeError('Cardmarket expansion index is required');
  }
  const id = Number(sourceExpansionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('sourceExpansionId must be a positive integer');
  const group = index.byExpansionId.get(id);
  if (!group) throw new Error(`Cardmarket expansion ${id} was not found in the catalogue index`);
  const signature = buildTcgdexSetCardSignature(tcgdexCards);

  const sourceGroups = new Map();
  for (const product of group.products) {
    const key = sourceCardGroupKey(product);
    if (!key) continue;
    const existing = sourceGroups.get(key) || [];
    existing.push(product);
    sourceGroups.set(key, existing);
  }

  const diagnostics = [];
  const mappedCanonicalCardIds = new Set();
  let mapped = 0;
  let ambiguous = 0;
  let unresolved = 0;
  let conflicts = 0;

  for (const [sourceCardGroup, products] of sourceGroups) {
    const names = new Set(products.map(productName).filter(Boolean));
    if (names.size !== 1) {
      conflicts += 1;
      diagnostics.push(Object.freeze({
        sourceCardGroup,
        sourceRecordIds: Object.freeze(products.map((product) => product.sourceRecordId)),
        status: 'conflict',
        reason: 'source_metacard_group_contains_multiple_names',
        sourceNames: Object.freeze([...names]),
      }));
      continue;
    }

    const normalizedName = [...names][0];
    const canonical = signature.cardsByName.get(normalizedName) || [];
    if (canonical.length === 0) {
      unresolved += 1;
      diagnostics.push(Object.freeze({
        sourceCardGroup,
        sourceRecordIds: Object.freeze(products.map((product) => product.sourceRecordId)),
        productName: products[0]?.name ?? null,
        status: 'unresolved',
        reason: 'no_exact_name_in_proven_canonical_set',
        candidates: Object.freeze([]),
      }));
      continue;
    }
    if (canonical.length > 1) {
      ambiguous += 1;
      diagnostics.push(Object.freeze({
        sourceCardGroup,
        sourceRecordIds: Object.freeze(products.map((product) => product.sourceRecordId)),
        productName: products[0]?.name ?? null,
        status: 'ambiguous',
        reason: 'same_name_multiple_collector_numbers_in_canonical_set',
        candidates: Object.freeze(canonical),
      }));
      continue;
    }

    mapped += 1;
    mappedCanonicalCardIds.add(canonical[0].id);
    diagnostics.push(Object.freeze({
      sourceCardGroup,
      sourceRecordIds: Object.freeze(products.map((product) => product.sourceRecordId)),
      productName: products[0]?.name ?? null,
      status: 'mapped_card_record',
      reason: 'proven_expansion_and_exact_name_unique_in_canonical_set',
      canonicalCard: canonical[0],
      variantResolved: false,
    }));
  }

  return Object.freeze({
    sourceExpansionId: id,
    proofScope: 'canonical_card_record_only',
    variantIdentityAvailableFromPublicCatalogue: false,
    counts: Object.freeze({
      sourceProducts: group.sourceProductCount,
      sourceCardGroups: sourceGroups.size,
      mappedCardGroups: mapped,
      ambiguousCardGroups: ambiguous,
      unresolvedCardGroups: unresolved,
      conflictCardGroups: conflicts,
      canonicalCardRefs: signature.cardCount,
      canonicalDistinctNames: signature.distinctNameCount,
      mappedDistinctCanonicalCards: mappedCanonicalCardIds.size,
      canonicalCardRecordCoverage: ratio(mappedCanonicalCardIds.size, signature.cardCount),
      sourceCardGroupMappingCoverage: ratio(mapped, sourceGroups.size),
    }),
    diagnostics: Object.freeze(diagnostics),
  });
}
