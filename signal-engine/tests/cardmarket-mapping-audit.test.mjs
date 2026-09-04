import assert from 'node:assert/strict';
import test from 'node:test';

import { auditApprovedCardmarketExpansion, rankCardmarketExpansionEvidence } from '../src/trader/value/cardmarket-mapping-audit.mjs';

function product(id, expansion, name) {
  return { sourceName: 'cardmarket', sourceRecordId: String(id), sourceExpansionId: expansion, name };
}

function card(id, printingId, name, collectorNumber, variantCode = 'standard') {
  return {
    id,
    fateCardId: id,
    printingId,
    name,
    collectorNumber,
    variantCode,
    languageCode: 'en',
    verificationStatus: 'verified',
  };
}

const cards = [
  card('c1', 'p1', 'Pikachu', '1'),
  card('c2', 'p2', 'Charizard ex', '2'),
  card('c3', 'p3', 'Mew ex', '3'),
  card('c4', 'p4', 'Energy Retrieval', '4'),
];

const products = [
  product(101, 10, 'Pikachu'),
  product(102, 10, 'Charizard ex'),
  product(103, 10, 'Mew ex'),
  product(104, 10, 'Live Code Card'),
  product(201, 20, 'Pikachu'),
  product(202, 20, 'Other Card'),
];

test('expansion evidence ranks only exact-name overlap and never approves a mapping', () => {
  const evidence = rankCardmarketExpansionEvidence(products, cards);
  assert.equal(evidence[0].sourceExpansionId, 10);
  assert.equal(evidence[0].exactNameOverlap, 3);
  assert.equal(evidence[0].canonicalExactNameCoverage, 0.75);
  assert.equal(evidence[0].approved, false);
  assert.equal(evidence[0].status, 'evidence_only');
  assert.equal(evidence[1].sourceExpansionId, 20);
});

test('approved expansion audit exposes exact unique candidates but performs no writes', () => {
  const audit = auditApprovedCardmarketExpansion(products, cards, 10);
  assert.equal(audit.writesPerformed, false);
  assert.equal(audit.approvedExpansionScopeRequired, true);
  assert.equal(audit.counts.sourceProducts, 4);
  assert.equal(audit.counts.exactUniquePrintingCandidates, 3);
  assert.equal(audit.counts.unresolved, 1);
  assert.equal(audit.diagnostics.every((row) => row.autoMappable === false), true);
});

test('same exact card name across canonical printings remains ambiguous', () => {
  const duplicateCards = [
    ...cards,
    card('c5', 'p5', 'Charizard ex', '200'),
  ];
  const audit = auditApprovedCardmarketExpansion(products, duplicateCards, 10);
  const charizard = audit.diagnostics.find((row) => row.productName === 'Charizard ex');
  assert.equal(charizard.status, 'ambiguous');
  assert.equal(charizard.reason, 'same_name_multiple_verified_printings');
});

test('near names do not become exact candidates', () => {
  const audit = auditApprovedCardmarketExpansion([product(301, 30, 'Pikachu ex')], cards, 30);
  assert.equal(audit.counts.exactUniquePrintingCandidates, 0);
  assert.equal(audit.counts.unresolved, 1);
});
