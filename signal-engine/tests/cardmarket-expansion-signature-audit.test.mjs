import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditCardmarketCanonicalCardCoverage,
  buildCardmarketExpansionIndex,
  classifyCardmarketExpansionEvidence,
  rankCardmarketExpansionNameEvidence,
} from '../src/trader/value/cardmarket-expansion-signature-audit.mjs';

function product(sourceExpansionId, sourceRecordId, name, sourceMetacardId) {
  return {
    sourceName: 'cardmarket',
    sourceExpansionId,
    sourceRecordId: String(sourceRecordId),
    sourceMetacardId,
    sourceDateAdded: Date.parse('2023-09-01T00:00:00Z'),
    name,
  };
}

function card(id, localId, name) {
  return { id, localId: String(localId), name };
}

test('whole-set ranking works with the actual public catalogue shape: plain names plus expansion ids', () => {
  const index = buildCardmarketExpansionIndex([
    product(101, 1, 'Bulbasaur', 1001),
    product(101, 2, 'Ivysaur', 1002),
    product(101, 3, 'Venusaur ex', 1003),
    product(101, 4, 'Charmander', 1004),
    product(101, 5, 'Charmeleon', 1005),
    product(202, 6, 'Bulbasaur', 2001),
    product(202, 7, 'Pikachu', 2002),
  ]);
  const cards = [
    card('set-1', 1, 'Bulbasaur'),
    card('set-2', 2, 'Ivysaur'),
    card('set-3', 3, 'Venusaur ex'),
    card('set-4', 4, 'Charmander'),
    card('set-5', 5, 'Charmeleon'),
  ];

  const candidates = rankCardmarketExpansionNameEvidence(index, cards);
  assert.equal(candidates[0].sourceExpansionId, 101);
  assert.equal(candidates[0].canonicalNameCoverage, 1);
  assert.equal(candidates[0].sourceNamePrecision, 1);
  const classification = classifyCardmarketExpansionEvidence(candidates);
  assert.equal(classification.status, 'proven');
  assert.equal(classification.sourceExpansionId, 101);
  assert.equal(classification.productVariantIdentityProven, false);
});

test('competing whole-set signatures remain ambiguous rather than being forced', () => {
  const products = [];
  for (const expansion of [101, 102]) {
    products.push(
      product(expansion, expansion * 10 + 1, 'Alpha', expansion * 100 + 1),
      product(expansion, expansion * 10 + 2, 'Beta', expansion * 100 + 2),
      product(expansion, expansion * 10 + 3, 'Gamma', expansion * 100 + 3),
      product(expansion, expansion * 10 + 4, 'Delta', expansion * 100 + 4),
      product(expansion, expansion * 10 + 5, 'Epsilon', expansion * 100 + 5),
    );
  }
  const cards = [
    card('a', 1, 'Alpha'),
    card('b', 2, 'Beta'),
    card('c', 3, 'Gamma'),
    card('d', 4, 'Delta'),
    card('e', 5, 'Epsilon'),
  ];
  const candidates = rankCardmarketExpansionNameEvidence(buildCardmarketExpansionIndex(products), cards);
  const classification = classifyCardmarketExpansionEvidence(candidates);
  assert.equal(classification.status, 'ambiguous');
  assert.deepEqual(classification.sourceExpansionIds, [101, 102]);
});

test('card record coverage maps only names unique inside a proven canonical set', () => {
  const index = buildCardmarketExpansionIndex([
    product(101, 1, 'Alpha', 1001),
    product(101, 2, 'Energy', 1002),
    product(101, 3, 'Unknown Source Card', 1003),
  ]);
  const cards = [
    card('a', 1, 'Alpha'),
    card('e1', 2, 'Energy'),
    card('e2', 99, 'Energy'),
  ];

  const audit = auditCardmarketCanonicalCardCoverage(index, cards, 101);
  assert.equal(audit.counts.mappedCardGroups, 1);
  assert.equal(audit.counts.ambiguousCardGroups, 1);
  assert.equal(audit.counts.unresolvedCardGroups, 1);
  assert.equal(audit.counts.mappedDistinctCanonicalCards, 1);
  assert.equal(audit.variantIdentityAvailableFromPublicCatalogue, false);
  assert.equal(audit.diagnostics.find((row) => row.productName === 'Energy').reason, 'same_name_multiple_collector_numbers_in_canonical_set');
});
