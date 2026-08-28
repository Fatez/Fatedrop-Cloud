import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveCardmarketRehearsal } from '../src/trader/value/cardmarket-live-rehearsal.mjs';
import { CARDMARKET_POKEMON_SOURCE_URLS } from '../src/trader/value/cardmarket-source-client.mjs';

const NOW = Date.parse('2026-08-28T01:00:00.000Z');

function cataloguePayload() {
  return {
    products: [
      { idProduct: 668227, idCategory: 51, idExpansion: 777, name: 'Pikachu ex', dateAdded: '2026-08-01 00:00:00' },
      { idProduct: 668228, idCategory: 51, idExpansion: 777, name: 'Pikachu ex', dateAdded: '2026-08-01 00:00:00' },
      { idProduct: 668229, idCategory: 51, idExpansion: 778, name: 'Mew ex', dateAdded: '2026-08-01 00:00:00' },
    ],
  };
}

function priceGuidePayload() {
  return {
    version: 1,
    createdAt: '2026-08-28T00:00:00+0000',
    priceGuides: [
      {
        idProduct: 668227, idCategory: 51,
        avg: 8.93, low: 5, trend: 11.25, avg1: 8.45, avg7: 8.8, avg30: 9.39,
        'avg-holo': 10.1, 'low-holo': 8, 'trend-holo': 10.5,
        'avg1-holo': 10, 'avg7-holo': 9.8, 'avg30-holo': 9.4,
      },
      {
        idProduct: 668228, idCategory: 51,
        avg: 813.33, low: 499, trend: 1056.35, avg1: 1950, avg7: 1003.75, avg30: 996.87,
        'avg-holo': null, 'low-holo': null, 'trend-holo': 0,
        'avg1-holo': null, 'avg7-holo': null, 'avg30-holo': null,
      },
      {
        idProduct: 668229, idCategory: 51,
        avg: 1, low: 0.2, trend: 1.2, avg1: 1.1, avg7: 1.05, avg30: 1,
        'avg-holo': null, 'low-holo': null, 'trend-holo': 0,
        'avg1-holo': null, 'avg7-holo': null, 'avg30-holo': null,
      },
    ],
  };
}

function canonicalState({ withCardMapping = true, withSetMapping = true } = {}) {
  return {
    traderCatalogue: {
      tcgs: {
        fdtcg_pokemon: { id: 'fdtcg_pokemon', code: 'pokemon' },
      },
      series: {
        fdseries: { id: 'fdseries', name: 'Test Series', verificationStatus: 'verified' },
      },
      sets: {
        fdset_777: { id: 'fdset_777', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries', name: 'Test Set', verificationStatus: 'verified' },
      },
      setSourceMappings: withSetMapping ? {
        'cardmarket|777': {
          id: 'fdsetmap_777', setId: 'fdset_777', sourceName: 'cardmarket', sourceRecordId: '777',
        },
      } : {},
      printings: {
        fdprinting_161: {
          id: 'fdprinting_161', name: 'Pikachu ex', rarity: 'Special Illustration Rare', verificationStatus: 'verified',
        },
      },
      cards: {
        fdcard_161: {
          id: 'fdcard_161', tcgId: 'fdtcg_pokemon', seriesId: 'fdseries', setId: 'fdset_777',
          printingId: 'fdprinting_161', collectorNumber: '161', variantCode: 'standard', languageCode: 'en',
          verificationStatus: 'verified', verifiedAt: NOW,
        },
      },
      cardSourceMappings: withCardMapping ? {
        'cardmarket|668227|normal': {
          id: 'fdcardmap_668227_normal', cardIdentityId: 'fdcard_161', sourceName: 'cardmarket',
          sourceRecordId: '668227', sourceVariantKey: 'normal',
        },
      } : {},
    },
  };
}

function fetchImpl(url) {
  const value = String(url);
  if (value === CARDMARKET_POKEMON_SOURCE_URLS.priceGuide) {
    return Promise.resolve(new Response(JSON.stringify(priceGuidePayload()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  if (value === CARDMARKET_POKEMON_SOURCE_URLS.singlesCatalogue) {
    return Promise.resolve(new Response(JSON.stringify(cataloguePayload()), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  throw new Error(`unexpected URL ${value}`);
}

test('live rehearsal reads canonical store and remains dry-run only', async () => {
  const store = { async read() { return canonicalState(); } };
  const report = await buildLiveCardmarketRehearsal({ store, fetchImpl, fetchedAt: NOW, limit: 1 });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.liveSource, true);
  assert.equal(report.persistenceAuthorized, false);
  assert.equal(report.sample.selected.length, 1);
  assert.equal(report.sample.selected[0].sourceRecordId, '668227');
  assert.ok(report.sample.selected[0].reasons.includes('duplicate-name-in-expansion'));
  assert.ok(report.sample.selected[0].reasons.includes('meaningful-holo-lane'));
  assert.equal(report.wouldInsert, 1);
  assert.equal(report.wouldReject, 1);
  assert.equal(report.rejections[0].sourceVariantKey, 'holo');
  assert.match(report.artifacts.priceGuide.sha256, /^[a-f0-9]{64}$/);
});

test('without exact card mapping, live rehearsal only suggests candidates inside verified mapped set', async () => {
  const store = { async read() { return canonicalState({ withCardMapping: false }); } };
  const report = await buildLiveCardmarketRehearsal({ store, fetchImpl, fetchedAt: NOW, limit: 1 });

  assert.equal(report.wouldInsert, 0);
  assert.equal(report.wouldReject, 2);
  assert.equal(report.diagnostics[0].status, 'candidate');
  assert.equal(report.diagnostics[0].crosswalk.autoMappable, false);
  assert.equal(report.diagnostics[0].crosswalk.candidates[0].fateCardId, 'fdcard_161');
});

test('without exact set crosswalk, live rehearsal refuses global catalogue matching', async () => {
  const store = { async read() { return canonicalState({ withCardMapping: false, withSetMapping: false }); } };
  const report = await buildLiveCardmarketRehearsal({ store, fetchImpl, fetchedAt: NOW, limit: 1 });

  assert.equal(report.wouldInsert, 0);
  assert.equal(report.diagnostics[0].status, 'unresolved');
  assert.equal(report.diagnostics[0].reason, 'verified_set_crosswalk_required');
  assert.equal(report.diagnostics[0].crosswalk, null);
});

test('sample selection prioritizes difficult rows rather than source order', async () => {
  const store = { async read() { return canonicalState({ withCardMapping: false }); } };
  const report = await buildLiveCardmarketRehearsal({ store, fetchImpl, fetchedAt: NOW, limit: 2 });

  assert.deepEqual(report.sample.selected.map((item) => item.sourceRecordId), ['668227', '668228']);
  assert.ok(report.sample.selected[1].reasons.includes('high-value'));
  assert.ok(report.sample.selected[1].reasons.includes('duplicate-name-in-expansion'));
});
