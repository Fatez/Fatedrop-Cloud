import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditApprovedCardmarketExpansion,
  rankCardmarketExpansionEvidence,
} from '../src/trader/value/cardmarket-mapping-audit.mjs';
import { parseCardmarketSingleProductName } from '../src/trader/value/cardmarket-crosswalk.mjs';

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

test('Cardmarket single names expose explicit provider set code and collector number', () => {
  assert.deepEqual(parseCardmarketSingleProductName('Bulbasaur (MEW 001)'), {
    cardName: 'Bulbasaur',
    sourceSetCode: 'MEW',
    sourceCollectorNumber: '001',
    collectorNumber: '1',
  });
  assert.deepEqual(parseCardmarketSingleProductName("Farfetch'd (MEW 083)"), {
    cardName: "Farfetch'd",
    sourceSetCode: 'MEW',
    sourceCollectorNumber: '083',
    collectorNumber: '83',
  });
  assert.equal(parseCardmarketSingleProductName('Bulbasaur'), null);
});

test('Cardmarket expansion ranking uses exact set code plus card name and collector number', () => {
  const cards = [
    card({ id: 'a-standard', name: 'Bulbasaur', number: '1' }),
    card({ id: 'a-reverse', name: 'Bulbasaur', number: '1', variant: 'reverse-holo' }),
    card({ id: 'b', name: 'Ivysaur', number: '2' }),
    card({ id: 'c', name: 'Venusaur ex', number: '3' }),
  ];
  const products = [
    product({ id: 10, expansion: 100, name: 'Bulbasaur (MEW 001)' }),
    product({ id: 11, expansion: 100, name: 'Ivysaur (MEW 002)' }),
    product({ id: 12, expansion: 100, name: 'Venusaur ex (MEW 003)' }),
    product({ id: 20, expansion: 200, name: 'Bulbasaur (sv2a 001)' }),
    product({ id: 21, expansion: 200, name: 'Ivysaur (sv2a 002)' }),
  ];

  const ranked = rankCardmarketExpansionEvidence(products, cards, {
    limit: 5,
    expectedSourceSetCode: 'MEW',
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sourceExpansionId, 100);
  assert.equal(ranked[0].canonicalDistinctPrintingKeyCount, 3);
  assert.equal(ranked[0].exactPrintingKeyOverlap, 3);
  assert.equal(ranked[0].canonicalExactPrintingCoverage, 1);
  assert.equal(ranked[0].sourceExactPrintingPrecision, 1);
  assert.equal(ranked[0].expectedSourceSetCode, 'MEW');
  assert.deepEqual(ranked[0].sourceSetCodes, { MEW: 3 });
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
    product({ id: 10, expansion: 100, name: 'Bulbasaur (MEW 001)' }),
    product({ id: 11, expansion: 100, name: 'Ivysaur (MEW 002)' }),
  ];

  const audit = auditApprovedCardmarketExpansion(products, cards, 100, { expectedSourceSetCode: 'MEW' });
  assert.equal(audit.writesPerformed, false);
  assert.equal(audit.approvedExpansionScopeRequired, true);
  assert.equal(audit.expectedSourceSetCode, 'MEW');
  assert.equal(audit.counts.sourceProducts, 2);
  assert.equal(audit.counts.variantConfirmationRequired, 1);
  assert.equal(audit.counts.exactUniquePrintingCandidates, 1);
  assert.ok(audit.diagnostics.every((row) => row.autoMappable === false));
});
