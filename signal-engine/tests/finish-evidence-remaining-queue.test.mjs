import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractTcgdexTcgplayerProductIds } from '../src/trader/value/tcgdex-tcgplayer-product-evidence.mjs';
import { buildReviewQueue } from '../src/trader/value/finish-evidence-review-queue-cli.mjs';

test('pinned TCGdex extractor only returns numeric TCGplayer ids from thirdParty blocks', () => {
  const source = `
    variants: [
      { type: 'holo', thirdParty: { cardmarket: 111, tcgplayer: 222 } },
      { type: 'reverse', thirdParty: { tcgplayer: 222 } },
      { type: 'normal', note: 'tcgplayer: 999' }
    ]`;
  assert.deepEqual(extractTcgdexTcgplayerProductIds(source), [222]);
});

test('review queue isolates zero-key cases and deck-or-box-risk negative candidates', () => {
  const targets = {
    productionWrites: false,
    targets: [
      { cardIdentityId: 'a', tcgdexCardId: 'sm1-80', name: 'A', collectorNumber: '80', variantCode: 'standard', priorExternalFinishKeys: ['holofoil'] },
      { cardIdentityId: 'b', tcgdexCardId: 'svp-1', name: 'B', collectorNumber: '1', variantCode: 'standard', priorExternalFinishKeys: [] },
    ],
  };
  const plan = {
    productionWrites: false,
    rows: [
      { cardIdentityId: 'a', state: 'UNRESOLVED_EVIDENCE', finish: 'standard', providerDiagnostic: 'other_finish_keys_only' },
      { cardIdentityId: 'b', state: 'UNRESOLVED_EVIDENCE', finish: 'standard', providerDiagnostic: 'no_recognised_finish_keys' },
    ],
  };
  const report = buildReviewQueue(targets, plan);
  assert.equal(report.counts.unresolved, 2);
  assert.equal(report.counts.negativeEvidenceCandidates, 1);
  assert.equal(report.counts.manualEdgeCases, 1);
  assert.equal(report.counts.deckOrBoxRisk, 1);
  assert.equal(report.rows.find(row => row.cardIdentityId === 'a').queue, 'negative_evidence_candidate');
  assert.equal(report.rows.find(row => row.cardIdentityId === 'b').queue, 'manual_edge_case');
});
