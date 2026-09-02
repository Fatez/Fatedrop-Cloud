import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOnePieceShadowReport,
  runOnePieceShadowScan,
} from '../src/trader/one-piece/shadow-monitor.mjs';
import { onePieceShadowRetailers } from '../src/trader/one-piece/shadow-retailers.mjs';

const retailer = onePieceShadowRetailers[0];

function product(overrides = {}) {
  return {
    retailerSku: 'op13-box',
    title: 'One Piece OP-13 English Booster Box',
    url: 'https://example.invalid/op13-box',
    pricePence: 99_99,
    stockStatus: 'out_of_stock',
    stockConfidence: 0.98,
    ...overrides,
  };
}

function run(products, { complete = true } = {}) {
  return { retailer, result: { products, complete } };
}

test('expanded UK One Piece shadow network remains disabled, unapproved and observation-only', () => {
  const expectedIds = [
    'cob-and-pip',
    'lz-collectibles',
    'card-goblin',
    'the-card-club-uk',
    'shake-central',
    'magic-madhouse',
    'chaos-cards',
    'double-sleeved',
    'total-cards',
    'titan-cards',
    'eterna-cards',
    'jet-cards',
    'gathering-games',
    'zatu-games',
  ];

  assert.equal(onePieceShadowRetailers.length, expectedIds.length);
  assert.deepEqual(onePieceShadowRetailers.map((entry) => entry.id), expectedIds);
  assert.equal(new Set(onePieceShadowRetailers.map((entry) => entry.id)).size, expectedIds.length);

  for (const entry of onePieceShadowRetailers) {
    assert.equal(entry.tcg, 'one-piece');
    assert.deepEqual(entry.tcgs, ['one-piece']);
    assert.equal(entry.enabled, false);
    assert.equal(entry.observationOnly, true);
    assert.equal(entry.rrpAuthority, 'none');
    assert.equal(entry.officialRrpSource, false);
    assert.equal(entry.catalogue.feedApproved, false);
    assert.equal(entry.catalogue.marketCountry, 'GB');

    if (entry.catalogue.feedUrl) {
      assert.match(entry.catalogue.feedUrl, /\/collections\/.+\/products\.json\?limit=250$/);
    } else {
      assert.ok(Array.isArray(entry.catalogueUrls));
      assert.ok(entry.catalogueUrls.length > 0);
    }
  }
});

test('existing FateDrop retailer identities are projected into One Piece shadow without changing their IDs', () => {
  const expectedSharedIds = [
    'magic-madhouse',
    'chaos-cards',
    'double-sleeved',
    'total-cards',
    'titan-cards',
    'eterna-cards',
    'jet-cards',
    'gathering-games',
    'zatu-games',
  ];
  const ids = new Set(onePieceShadowRetailers.map((entry) => entry.id));
  for (const id of expectedSharedIds) assert.equal(ids.has(id), true, `${id} should reuse the canonical retailer identity`);
});

test('the first successful retailer observation creates a silent baseline with no alert surface', () => {
  const report = buildOnePieceShadowReport({
    retailerRuns: [run([product({ stockStatus: 'in_stock' })])],
    observedAt: 100,
  });

  assert.equal(report.firstBaseline, true);
  assert.equal(report.silentBaseline, true);
  assert.deepEqual(report.silentBaselineRetailers, [retailer.id]);
  assert.equal(report.publicBrowseEnabled, false);
  assert.equal(report.lifecycleAlertsEnabled, false);
  assert.equal(report.episodes.length, 0);
  assert.equal(report.baseline.retailerStates[0].baselineEstablished, true);
});

test('offer-level availability episodes begin only after the silent baseline', () => {
  const baseline = buildOnePieceShadowReport({
    retailerRuns: [run([product()])],
    observedAt: 100,
  }).baseline;
  const report = buildOnePieceShadowReport({
    retailerRuns: [run([product({ stockStatus: 'in_stock' })])],
    previousBaseline: baseline,
    observedAt: 200,
  });

  assert.equal(report.silentBaseline, false);
  assert.equal(report.episodes.length, 1);
  assert.equal(report.episodes[0].kind, 'availability_observed');
  assert.equal(report.episodes[0].observationOnly, true);
  assert.equal(report.lifecycleAlertsEnabled, false);
});

test('incomplete and failed scans retain the previous baseline and never mark offers stale', () => {
  const initial = buildOnePieceShadowReport({ retailerRuns: [run([product()])], observedAt: 100 }).baseline;
  const partial = buildOnePieceShadowReport({
    retailerRuns: [run([], { complete: false })],
    previousBaseline: initial,
    observedAt: 200,
  });
  const failed = buildOnePieceShadowReport({
    retailerRuns: [{ retailer, error: new Error('blocked') }],
    previousBaseline: initial,
    observedAt: 200,
  });

  assert.equal(partial.totals.stale, 0);
  assert.equal(partial.baseline.offers.length, 1);
  assert.equal(failed.totals.stale, 0);
  assert.equal(failed.baseline.offers.length, 1);
  assert.equal(failed.retailers[0].healthy, false);
});

test('a complete post-baseline scan reports missing products as stale and removes them from the next baseline', () => {
  const initial = buildOnePieceShadowReport({ retailerRuns: [run([product()])], observedAt: 100 }).baseline;
  const report = buildOnePieceShadowReport({
    retailerRuns: [run([])],
    previousBaseline: initial,
    observedAt: 200,
  });

  assert.equal(report.totals.stale, 1);
  assert.equal(report.retailers[0].stale, 1);
  assert.equal(report.baseline.offers.length, 0);
  assert.equal(report.episodes.length, 0);
});

test('shadow runner explicitly opts into unapproved feeds without changing registry approval', async () => {
  const calls = [];
  const report = await runOnePieceShadowScan({
    retailers: [retailer],
    observedAt: 100,
    scanSource: async (entry, options) => {
      calls.push({ entry, options });
      return { products: [], complete: true };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.allowUnapprovedFeed, true);
  assert.equal(calls[0].entry.catalogue.feedApproved, false);
  assert.equal(report.mode, 'observation_only');
  assert.equal(report.lifecycleAlertsEnabled, false);
});
