import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessOnePieceCatalogueReadiness,
  ONE_PIECE_CATALOGUE_SOURCE_ROLES,
} from '../src/trader/one-piece/catalogue-readiness.mjs';

const now = 2_000_000;

function sources(overrides = {}) {
  return [
    {
      sourceName: 'licensed-canonical',
      role: ONE_PIECE_CATALOGUE_SOURCE_ROLES.CANONICAL_DATA,
      commercialUseApproved: true,
      licenceReference: 'contract:fixture',
      scopeComplete: true,
      expectedSetCount: 1,
      expectedCardCount: 1,
      snapshotObservedAt: now - 60,
      ...overrides,
    },
    {
      sourceName: 'official-verification',
      role: ONE_PIECE_CATALOGUE_SOURCE_ROLES.VERIFICATION_ONLY,
      commercialUseApproved: false,
      licenceReference: 'official-reference:fixture',
      scopeComplete: false,
      snapshotObservedAt: now - 60,
    },
  ];
}

function setEvidence(overrides = {}) {
  return {
    sourceName: 'licensed-canonical',
    sourceRecordId: 'op01',
    marketCode: 'GB',
    languageCode: 'en',
    seriesName: 'Release Series',
    setName: 'Romance Dawn',
    sourceSetCode: 'OP-01',
    printedTotal: 121,
    total: 121,
    releasedAt: 1_669_939_200,
    ...overrides,
  };
}

function cardEvidence(overrides = {}) {
  return {
    sourceName: 'licensed-canonical',
    sourceRecordId: 'op01-001',
    marketCode: 'GB',
    languageCode: 'en',
    seriesName: 'Release Series',
    setName: 'Romance Dawn',
    sourceSetCode: 'OP-01',
    collectorNumber: '001',
    printingCode: 'main',
    name: 'Fixture Card',
    rarity: 'L',
    variantEvidenceAvailable: true,
    ...overrides,
  };
}

test('complete licensed data plus independent verification may pass only the catalogue shadow gate', () => {
  const report = assessOnePieceCatalogueReadiness({
    sourceDeclarations: sources(),
    setEvidence: [setEvidence()],
    cardEvidence: [cardEvidence()],
    now,
  });

  assert.equal(report.catalogueGatePass, true);
  assert.equal(report.gates.sourceRightsReady, true);
  assert.equal(report.gates.independentVerificationReady, true);
  assert.equal(report.gates.setCoverageReady, true);
  assert.equal(report.gates.cardCoverageReady, true);
  assert.equal(report.publicBrowseEnabled, false);
  assert.equal(report.retailerMonitoringEnabled, false);
  assert.equal(report.lifecycleAlertsEnabled, false);
});

test('an official verification reference alone never grants canonical data import rights', () => {
  const report = assessOnePieceCatalogueReadiness({
    sourceDeclarations: sources({ commercialUseApproved: false, licenceReference: null }),
    setEvidence: [setEvidence()],
    cardEvidence: [cardEvidence()],
    now,
  });

  assert.equal(report.catalogueGatePass, false);
  assert.equal(report.gates.sourceRightsReady, false);
  assert.equal(report.sets.counts.rightsRejected, 1);
  assert.equal(report.cards.counts.rightsRejected, 1);
});

test('missing variant proof remains unresolved instead of inventing a complete card identity', () => {
  const report = assessOnePieceCatalogueReadiness({
    sourceDeclarations: sources(),
    setEvidence: [setEvidence()],
    cardEvidence: [cardEvidence({ variantEvidenceAvailable: false })],
    now,
  });

  assert.equal(report.catalogueGatePass, false);
  assert.equal(report.cards.counts.unresolved, 1);
  assert.equal(report.cards.results[0].status, 'unresolved');
  assert.ok(report.cards.results[0].reasons.includes('variant_evidence_unresolved'));
});

test('conflicting canonical identities and stale snapshots fail closed', () => {
  const conflict = assessOnePieceCatalogueReadiness({
    sourceDeclarations: sources({ expectedCardCount: 1 }),
    setEvidence: [setEvidence()],
    cardEvidence: [cardEvidence(), cardEvidence({ sourceRecordId: 'op01-001-conflict', name: 'Different Card' })],
    now,
  });
  const stale = assessOnePieceCatalogueReadiness({
    sourceDeclarations: sources({ snapshotObservedAt: now - (8 * 24 * 60 * 60) }),
    setEvidence: [setEvidence()],
    cardEvidence: [cardEvidence()],
    now,
  });

  assert.equal(conflict.catalogueGatePass, false);
  assert.equal(conflict.cards.counts.conflicting, 2);
  assert.equal(stale.catalogueGatePass, false);
  assert.equal(stale.sets.counts.stale, 1);
  assert.equal(stale.cards.counts.stale, 1);
});

test('disagreeing complete-source counts block completeness rather than choosing one', () => {
  const declaration = sources();
  declaration.push({
    ...declaration[0],
    sourceName: 'second-licensed-source',
    licenceReference: 'contract:second',
    expectedSetCount: 2,
  });
  const report = assessOnePieceCatalogueReadiness({
    sourceDeclarations: declaration,
    setEvidence: [setEvidence()],
    cardEvidence: [cardEvidence()],
    now,
  });

  assert.equal(report.catalogueGatePass, false);
  assert.equal(report.gates.expectedCountsReady, false);
  assert.equal(report.expected.sets, null);
});
