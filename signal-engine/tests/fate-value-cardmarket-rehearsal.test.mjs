import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCardmarketRehearsalReport } from '../src/trader/value/cardmarket-rehearsal.mjs';

const NOW = Date.parse('2026-08-28T00:00:00.000Z');

function catalogue(name = 'Pikachu ex') {
  return {
    products: [{
      idProduct: 668227,
      idCategory: 51,
      idExpansion: 777,
      name,
      dateAdded: '2026-08-01 00:00:00',
    }],
  };
}

function guide({ holo = false } = {}) {
  return {
    version: 1,
    createdAt: '2026-08-28T00:00:00+0200',
    priceGuides: [{
      idProduct: 668227,
      idCategory: 51,
      avg: 8.93,
      low: 5,
      trend: 11.25,
      avg1: 8.45,
      avg7: 8.8,
      avg30: 9.39,
      'avg-holo': holo ? 10.1 : null,
      'low-holo': holo ? 8 : null,
      'trend-holo': holo ? 10.5 : 0,
      'avg1-holo': holo ? 10 : null,
      'avg7-holo': holo ? 9.8 : null,
      'avg30-holo': holo ? 9.4 : null,
    }],
  };
}

function verifiedCard(overrides = {}) {
  return {
    id: 'fdcard_verified',
    fateCardId: 'fdcard_verified',
    printingId: 'fdprinting_verified',
    name: 'Pikachu ex',
    collectorNumber: '161',
    variantCode: 'standard',
    languageCode: 'en',
    verificationStatus: 'verified',
    ...overrides,
  };
}

function exactMapping() {
  return {
    id: 'fdcardmap_cardmarket_668227_normal',
    cardIdentityId: 'fdcard_verified',
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
  };
}

test('dry-run report emits would-insert evidence without authorizing persistence', async () => {
  const report = await buildCardmarketRehearsalReport({
    cataloguePayload: catalogue(),
    priceGuidePayload: guide(),
    resolveMapping: async ({ priceGuideLane }) => (
      priceGuideLane === 'standard' ? exactMapping() : null
    ),
    resolveVerifiedSetCards: async () => [verifiedCard()],
    observedAt: NOW,
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.persistenceAuthorized, false);
  assert.equal(report.wouldInsert, 1);
  assert.equal(report.wouldReject, 0);
  assert.equal(report.observations[0].cardIdentityId, 'fdcard_verified');
  assert.equal(report.sourceCurrency, 'EUR');
});

test('unmapped product stays rejected while exposing only a manual crosswalk candidate', async () => {
  const report = await buildCardmarketRehearsalReport({
    cataloguePayload: catalogue(),
    priceGuidePayload: guide(),
    resolveMapping: async () => null,
    resolveVerifiedSetCards: async () => [verifiedCard()],
    observedAt: NOW,
  });

  assert.equal(report.wouldInsert, 0);
  assert.equal(report.wouldReject, 1);
  assert.equal(report.diagnostics[0].status, 'candidate');
  assert.equal(report.diagnostics[0].crosswalk.autoMappable, false);
  assert.equal(report.diagnostics[0].crosswalk.candidates[0].fateCardId, 'fdcard_verified');
});

test('rehearsal refuses to search globally when verified set scope is unavailable', async () => {
  const report = await buildCardmarketRehearsalReport({
    cataloguePayload: catalogue(),
    priceGuidePayload: guide(),
    resolveMapping: async () => null,
    resolveVerifiedSetCards: async () => null,
    observedAt: NOW,
  });

  assert.equal(report.diagnostics[0].status, 'unresolved');
  assert.equal(report.diagnostics[0].reason, 'verified_set_crosswalk_required');
  assert.equal(report.diagnostics[0].crosswalk, null);
});

test('several variants remain manual and never become auto-mappable', async () => {
  const report = await buildCardmarketRehearsalReport({
    cataloguePayload: catalogue(),
    priceGuidePayload: guide(),
    resolveMapping: async () => null,
    resolveVerifiedSetCards: async () => [
      verifiedCard(),
      verifiedCard({
        id: 'fdcard_reverse',
        fateCardId: 'fdcard_reverse',
        variantCode: 'reverse-holo',
      }),
    ],
    observedAt: NOW,
  });

  assert.equal(report.diagnostics[0].status, 'candidate');
  assert.equal(report.diagnostics[0].reason, 'printing_identified_variant_confirmation_required');
  assert.equal(report.diagnostics[0].crosswalk.autoMappable, false);
  assert.equal(report.diagnostics[0].crosswalk.candidates.length, 2);
});

test('meaningful holo lane is a separate unresolved diagnostic when only standard is mapped', async () => {
  const report = await buildCardmarketRehearsalReport({
    cataloguePayload: catalogue(),
    priceGuidePayload: guide({ holo: true }),
    resolveMapping: async ({ priceGuideLane }) => (
      priceGuideLane === 'standard' ? exactMapping() : null
    ),
    resolveVerifiedSetCards: async () => [verifiedCard()],
    observedAt: NOW,
  });

  assert.equal(report.wouldInsert, 1);
  assert.equal(report.wouldReject, 1);
  assert.equal(report.diagnostics[0].sourceVariantKey, 'holo');
  assert.equal(report.diagnostics[0].crosswalk.autoMappable, false);
});
