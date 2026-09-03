import test from 'node:test';
import assert from 'node:assert/strict';

import { getFateCollectorSummaryFromStore } from '../src/trader/collection/collector-summary-service.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function catalogue() {
  return {
    tcgs: {
      tcg_pokemon: { id: 'tcg_pokemon', code: 'pokemon', name: 'Pokemon' },
    },
    series: {
      series_1: { id: 'series_1', tcgId: 'tcg_pokemon', code: 'series-1', name: 'Series 1', verificationStatus: 'verified' },
    },
    sets: {
      set_1: {
        id: 'set_1',
        tcgId: 'tcg_pokemon',
        seriesId: 'series_1',
        code: 'set-1',
        name: 'Test Set',
        printedTotal: 2,
        total: 2,
        verificationStatus: 'verified',
      },
    },
    printings: {
      printing_1: { id: 'printing_1', setId: 'set_1', name: 'Card One', collectorNumber: '1', verificationStatus: 'verified' },
      printing_2: { id: 'printing_2', setId: 'set_1', name: 'Card Two', collectorNumber: '2', verificationStatus: 'verified' },
    },
    cards: {
      card_1: {
        id: 'card_1',
        tcgId: 'tcg_pokemon',
        seriesId: 'series_1',
        setId: 'set_1',
        printingId: 'printing_1',
        collectorNumber: '1',
        variantCode: 'standard',
        languageCode: 'en',
        verificationStatus: 'verified',
      },
      card_2: {
        id: 'card_2',
        tcgId: 'tcg_pokemon',
        seriesId: 'series_1',
        setId: 'set_1',
        printingId: 'printing_2',
        collectorNumber: '2',
        variantCode: 'standard',
        languageCode: 'en',
        verificationStatus: 'verified',
      },
    },
    setSourceMappings: {},
    cardSourceMappings: {},
    cardProvenance: {},
  };
}

function collection() {
  return {
    collections: {
      collection_1: {
        id: 'collection_1',
        userId: 'user_1',
        tcgId: 'tcg_pokemon',
        name: 'My Collection',
        visibility: 'private',
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000,
      },
    },
    items: {
      item_1: {
        id: 'item_1',
        collectionId: 'collection_1',
        fateCardId: 'card_1',
        quantity: 1,
        tradeQuantity: 0,
        copyState: 'raw',
        conditionCode: 'near_mint',
        notes: null,
        status: 'active',
        revision: 1,
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000,
      },
    },
    grading: {},
    media: {},
    wants: {},
    events: [],
  };
}

function run(id, sourceSnapshotId) {
  return {
    id,
    sourceName: 'cardmarket',
    sourceSnapshotId,
    metadataJson: {
      providerPolicyKey: 'cardmarket-public-download',
      acquisitionMode: 'public-download',
    },
  };
}

function priceObservation({ id, runId, snapshotId, cardIdentityId, trendPrice, sourceEffectiveAt }) {
  return {
    id,
    ingestRunId: runId,
    cardIdentityId,
    sourceName: 'cardmarket',
    sourceSnapshotId: snapshotId,
    currencyCode: 'EUR',
    sourceEffectiveAt,
    observedAt: sourceEffectiveAt + 1000,
    trendPrice,
  };
}

function storeWithPrices({ includeMissingCardPrice = true, includeHistory = false } = {}) {
  const currentAt = NOW - 60 * 60 * 1000;
  const ingestRuns = {
    current: run('current', 'current-snapshot'),
  };
  const observations = {
    current_card_1: priceObservation({
      id: 'current_card_1', runId: 'current', snapshotId: 'current-snapshot', cardIdentityId: 'card_1', trendPrice: 10, sourceEffectiveAt: currentAt,
    }),
  };
  if (includeMissingCardPrice) {
    observations.current_card_2 = priceObservation({
      id: 'current_card_2', runId: 'current', snapshotId: 'current-snapshot', cardIdentityId: 'card_2', trendPrice: 20, sourceEffectiveAt: currentAt,
    });
  }

  if (includeHistory) {
    ingestRuns.seven = run('seven', 'seven-snapshot');
    ingestRuns.thirty = run('thirty', 'thirty-snapshot');
    const sevenAt = NOW - 7 * DAY - 60 * 60 * 1000;
    const thirtyAt = NOW - 30 * DAY - 60 * 60 * 1000;
    observations.seven_card_1 = priceObservation({
      id: 'seven_card_1', runId: 'seven', snapshotId: 'seven-snapshot', cardIdentityId: 'card_1', trendPrice: 8, sourceEffectiveAt: sevenAt,
    });
    observations.seven_card_2 = priceObservation({
      id: 'seven_card_2', runId: 'seven', snapshotId: 'seven-snapshot', cardIdentityId: 'card_2', trendPrice: 16, sourceEffectiveAt: sevenAt,
    });
    observations.thirty_card_1 = priceObservation({
      id: 'thirty_card_1', runId: 'thirty', snapshotId: 'thirty-snapshot', cardIdentityId: 'card_1', trendPrice: 5, sourceEffectiveAt: thirtyAt,
    });
    observations.thirty_card_2 = priceObservation({
      id: 'thirty_card_2', runId: 'thirty', snapshotId: 'thirty-snapshot', cardIdentityId: 'card_2', trendPrice: 10, sourceEffectiveAt: thirtyAt,
    });
  }

  const state = {
    traderCatalogue: catalogue(),
    traderCollection: collection(),
    fateValueLab: {
      ingestRuns,
      observations,
      rejections: {},
    },
  };
  return { read: async () => state };
}

test('collector summary connects owned, set and missing values to approved Fate Price evidence', async () => {
  const result = await getFateCollectorSummaryFromStore(storeWithPrices(), {
    userId: 'user_1',
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
    asOf: NOW,
  });

  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  assert.equal(result.summary.collection.totalValue, 10);
  assert.equal(result.summary.collection.priceCoveragePercent, 100);
  assert.equal(result.summary.setsOwned, 1);
  assert.equal(result.summary.closestSet.completionPercent, 50);
  assert.equal(result.summary.closestSet.missingCount, 1);

  const set = result.summary.sets[0];
  assert.equal(set.value.fullSetValue, 30);
  assert.equal(set.value.ownedValue, 10);
  assert.equal(set.value.missingValue, 20);
  assert.equal(set.value.priceCoveragePercent, 100);

  assert.equal(result.evidence.completeSetValuesConnected, true);
  assert.equal(result.evidence.requestedPriceIdentityCount, 2);
  assert.equal(result.evidence.resolvedPriceIdentityCount, 2);
  assert.equal(result.evidence.rejectedPricingProvenanceCount, 0);
  assert.equal(result.summary.movement.sevenDay.status, 'unavailable');
  assert.equal(result.summary.movement.thirtyDay.status, 'unavailable');
});

test('collector summary calculates 7D/30D movement from historical approved prices', async () => {
  const result = await getFateCollectorSummaryFromStore(storeWithPrices({ includeHistory: true }), {
    userId: 'user_1',
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
    asOf: NOW,
  });

  assert.equal(result.summary.movement.basis, 'current-holdings-repriced');
  assert.equal(result.summary.movement.sevenDay.collection.status, 'available');
  assert.equal(result.summary.movement.sevenDay.collection.amountChange, 2);
  assert.equal(result.summary.movement.sevenDay.collection.percentChange, 25);
  assert.equal(result.summary.movement.thirtyDay.collection.amountChange, 5);
  assert.equal(result.summary.movement.thirtyDay.collection.percentChange, 100);

  const set7 = result.summary.movement.sevenDay.sets[0];
  assert.equal(set7.value.fullSet.amountChange, 6);
  assert.equal(set7.value.owned.amountChange, 2);
  assert.equal(set7.value.missing.amountChange, 4);
  assert.equal(result.evidence.sevenDayValuationStatus, 'available');
  assert.equal(result.evidence.thirtyDayValuationStatus, 'available');
});

test('collector summary exposes partial coverage instead of inventing missing-card value', async () => {
  const result = await getFateCollectorSummaryFromStore(storeWithPrices({ includeMissingCardPrice: false }), {
    userId: 'user_1',
    currencyCode: 'EUR',
    preferredLanguageCode: 'en',
    preferredVariantCode: 'standard',
    asOf: NOW,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'market_price_coverage_incomplete');
  assert.equal(result.summary.collection.totalValue, 10);

  const set = result.summary.sets[0];
  assert.equal(set.value.status, 'partial');
  assert.equal(set.value.fullSetValue, null);
  assert.equal(set.value.knownSetValue, 10);
  assert.equal(set.value.missingValue, null);
  assert.equal(set.value.missingPriceCoveragePercent, 0);
  assert.equal(result.evidence.resolvedPriceIdentityCount, 1);
  assert.equal(result.evidence.unavailablePriceIdentityCount, 1);
});
