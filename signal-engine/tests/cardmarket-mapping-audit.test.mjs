import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditApprovedCardmarketExpansion,
  rankCardmarketExpansionEvidence,
} from '../src/trader/value/cardmarket-mapping-audit.mjs';

function card({ name, number, variant = 'standard', id }) {
  return {
    fateCardId: id,
    name,
    collectorNumber: number,
    variantCode: variant,
    languageCode: 'en',
    verificationStatus: 'verified',
  };
}

function product({ id, expansion, name }) {
  return {
    sourceName: 'cardmarket',
    sourceRecordId: String(id),
    sourceExpansionId: expansion,
    name,
  };
}

test('Cardmarket expansion ranking is evidence only and prefers broad exact-name overlap', () => {
  const cards = [
    card({ id: 'a-standard', name: 'Bulbasaur', number: '1' }),
    card({ id: 'a-reverse', name: 'Bulbasaur', number: '1', variant: 'reverse-holo' }),
    card({ id: 'b', name: 'Ivysaur', number: '2' }),
    card({ id: 'c', name: 'Venusaur ex', number: '3' }),
  ];
  const products = [
    product({ id: 10, expansion: 100, name: 'Bulbasaur' }),
    product({ id: 11, expansion: 100, name: 'Ivysaur' }),
    product({ id: 12, expansion: 100, name: 'Venusaur ex' }),
    product({ id: 20, expansion: 200, name: 'Bulbasaur' }),
    product({ id: 21, expansion: 200, name: 'Random Card' }),
  ];

  const ranked = rankCardmarketExpansionEvidence(products, cards, { limit: 5 });
  assert.equal(ranked[0].sourceExpansionId, 100);
  assert.equal(ranked[0].canonicalDistinctNameCount, 3);
  assert.equal(ranked[0].exactNameOverlap, 3);
  assert.equal(ranked[0].canonicalExactNameCoverage, 1);
  assert.equal(ranked[0].status, 'evidence_only');
  assert.equal(ranked[0].approved, false);
});

test('approved expansion audit remains non-writing and requires variant confirmation where needed', () => {
  const cards = [
    card({ id: 'a-standard', name: 'Bulbasaur', number: '1' }),
    card({ id: 'a-reverse', name: 'Bulbasaur', number: '1', variant: 'reverse-holo' }),
    card({ id: 'b', name: 'Ivysaur', number: '2' }),
  ];
  const products = [
    product({ id: 10, expansion: 100, name: 'Bulbasaur' }),
    product({ id: 11, expansion: 100, name: 'Ivysaur' }),
  ];

  const audit = auditApprovedCardmarketExpansion(products, cards, 100);
  assert.equal(audit.writesPerformed, false);
  assert.equal(audit.approvedExpansionScopeRequired, true);
  assert.equal(audit.counts.sourceProducts, 2);
  assert.equal(audit.counts.variantConfirmationRequired, 1);
  assert.equal(audit.counts.exactUniquePrintingCandidates, 1);
  assert.ok(audit.diagnostics.every((row) => row.autoMappable === false));
});
