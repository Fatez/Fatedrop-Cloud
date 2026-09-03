import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMarketPulseSnapshot } from '../src/trader/value/market-pulse.mjs';

const NOW = Date.parse('2026-09-03T10:00:00.000Z');

const identities = {
  card_p1: {
    id: 'card_p1',
    name: 'Pikachu',
    tcgCode: 'pokemon',
    seriesCode: 'scarlet-violet',
    setCode: 'sv08',
    collectorNumber: '57',
  },
  card_p2: {
    id: 'card_p2',
    name: 'Latias ex',
    tcgCode: 'pokemon',
    seriesCode: 'scarlet-violet',
    setCode: 'sv08',
    collectorNumber: '239',
  },
  card_op1: {
    id: 'card_op1',
    name: 'Monkey.D.Luffy',
    tcgCode: 'one-piece',
    seriesCode: 'one-piece-card-game',
    setCode: 'op09',
    collectorNumber: '119',
  },
};

function obs(cardIdentityId, marketDay, trendPrice, overrides = {}) {
  return {
    cardIdentityId,
    sourceName: 'cardmarket',
    sourceSnapshotId: `prices-${marketDay}`,
    sourceRecordId: cardIdentityId,
    sourceVariantKey: 'normal',
    marketSegmentKey: 'default',
    conditionCode: 'unspecified',
    currencyCode: 'EUR',
    marketDay,
    observedAt: Date.parse(`${marketDay}T08:00:00.000Z`),
    sourceEffectiveAt: Date.parse(`${marketDay}T00:00:00.000Z`),
    trendPrice,
    ...overrides,
  };
}

function snapshot(observations, overrides = {}) {
  return buildMarketPulseSnapshot({
    observations,
    cardIdentities: identities,
    sourceName: 'cardmarket',
    priceField: 'trendPrice',
    currencyCode: 'EUR',
    generatedAt: NOW,
    ...overrides,
  });
}

test('builds exact 1d, 7d and 30d card movements from one explicit price field', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 100),
    obs('card_p1', '2026-09-02', 80),
    obs('card_p1', '2026-08-27', 50),
    obs('card_p1', '2026-08-04', 40),
  ]);

  assert.equal(result.anchorMarketDay, '2026-09-03');
  assert.equal(result.cards.length, 1);
  assert.deepEqual(result.cards[0].movement.d1, { amount: 20, percent: 25 });
  assert.deepEqual(result.cards[0].movement.d7, { amount: 50, percent: 100 });
  assert.deepEqual(result.cards[0].movement.d30, { amount: 60, percent: 150 });
});

test('does not substitute nearby dates when an exact baseline day is missing', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 100),
    obs('card_p1', '2026-09-01', 80),
    obs('card_p1', '2026-08-27', 50),
  ]);

  assert.equal(result.cards[0].movement.d1, null);
  assert.deepEqual(result.cards[0].movement.d7, { amount: 50, percent: 100 });
  assert.equal(result.movement.d1.contributors, 0);
  assert.equal(result.movement.d1.coveragePct, 0);
});

test('keeps source, currency, segment and condition lanes isolated', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 100),
    obs('card_p1', '2026-09-02', 80),
    obs('card_p1', '2026-09-03', 999, { sourceName: 'other-source' }),
    obs('card_p1', '2026-09-02', 1, { currencyCode: 'GBP' }),
    obs('card_p1', '2026-09-02', 1, { marketSegmentKey: 'foil' }),
    obs('card_p1', '2026-09-02', 1, { conditionCode: 'near-mint' }),
  ]);

  assert.equal(result.evidence.observationsConsidered, 2);
  assert.deepEqual(result.cards[0].movement.d1, { amount: 20, percent: 25 });
});

test('aggregates market, game and set movement without pokemon-only assumptions', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 110),
    obs('card_p1', '2026-09-02', 100),
    obs('card_p2', '2026-09-03', 90),
    obs('card_p2', '2026-09-02', 100),
    obs('card_op1', '2026-09-03', 120),
    obs('card_op1', '2026-09-02', 100),
  ]);

  assert.equal(result.games.length, 2);
  assert.equal(result.sets.length, 2);

  const pokemon = result.games.find((game) => game.tcgCode === 'pokemon');
  const onePiece = result.games.find((game) => game.tcgCode === 'one-piece');
  const sv08 = result.sets.find((set) => set.setCode === 'sv08');

  assert.equal(pokemon.currentCardCount, 2);
  assert.equal(pokemon.movement.d1.meanPercent, 0);
  assert.equal(onePiece.movement.d1.meanPercent, 20);
  assert.equal(sv08.movement.d1.rising, 1);
  assert.equal(sv08.movement.d1.falling, 1);
  assert.equal(result.movement.d1.contributors, 3);
  assert.equal(result.movement.d1.meanPercent, 6.666667);
});

test('reports baseline coverage instead of inventing confidence', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 110),
    obs('card_p1', '2026-09-02', 100),
    obs('card_p2', '2026-09-03', 90),
  ]);

  assert.equal(result.movement.d1.eligible, 2);
  assert.equal(result.movement.d1.contributors, 1);
  assert.equal(result.movement.d1.coveragePct, 50);
  assert.equal('confidence' in result, false);
});

test('uses one global anchor day and marks stale lanes instead of mixing market dates', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 110),
    obs('card_p1', '2026-09-02', 100),
    obs('card_p2', '2026-09-02', 90),
    obs('card_p2', '2026-09-01', 80),
  ]);

  assert.equal(result.anchorMarketDay, '2026-09-03');
  assert.equal(result.evidence.mappedLaneCount, 2);
  assert.equal(result.evidence.currentLaneCount, 1);
  assert.equal(result.evidence.staleLaneCount, 1);
  assert.deepEqual(result.cards.map((card) => card.cardIdentityId), ['card_p1']);
});

test('excludes unresolved card identities and records the evidence gap', () => {
  const result = snapshot([
    obs('card_missing', '2026-09-03', 100),
    obs('card_p1', '2026-09-03', 90),
  ]);

  assert.equal(result.evidence.unresolvedIdentityCount, 1);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].cardIdentityId, 'card_p1');
});

test('never silently chooses a different price metric', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', null, { marketPrice: 100 }),
    obs('card_p1', '2026-09-02', null, { marketPrice: 80 }),
  ]);

  assert.equal(result.evidence.currentLaneCount, 0);
  assert.equal(result.cards.length, 0);

  const marketPriceResult = snapshot([
    obs('card_p1', '2026-09-03', null, { marketPrice: 100 }),
    obs('card_p1', '2026-09-02', null, { marketPrice: 80 }),
  ], { priceField: 'marketPrice' });

  assert.deepEqual(marketPriceResult.cards[0].movement.d1, { amount: 20, percent: 25 });
});

test('zero baselines preserve absolute movement but leave percent unknown', () => {
  const result = snapshot([
    obs('card_p1', '2026-09-03', 10),
    obs('card_p1', '2026-09-02', 0),
  ]);

  assert.deepEqual(result.cards[0].movement.d1, { amount: 10, percent: null });
  assert.equal(result.movement.d1.contributors, 1);
  assert.equal(result.movement.d1.percentContributors, 0);
  assert.equal(result.movement.d1.meanPercent, null);
});

test('empty evidence returns a stable empty contract', () => {
  const result = snapshot([]);

  assert.equal(result.schemaVersion, 'market-pulse:1a');
  assert.equal(result.anchorMarketDay, null);
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.games, []);
  assert.deepEqual(result.sets, []);
  assert.equal(result.movement.d30.coveragePct, null);
});

test('rejects unsupported price fields rather than creating a valuation policy', () => {
  assert.throws(() => snapshot([], { priceField: 'fateFairValue' }), /priceField must be one of/);
});
