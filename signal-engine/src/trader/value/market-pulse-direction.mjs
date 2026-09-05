const PERIOD_KEYS = Object.freeze(['d1', 'd7', 'd30']);
const DEFAULT_MINIMUM_SET_COVERAGE_PCT = 95;
const DEFAULT_RANKING_LIMIT = 3;

function optionalText(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function roundMetric(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return roundMetric(Math.min(100, (numerator / denominator) * 100));
}

function stableKey(item) {
  return [item.tcgCode ?? '', item.setCode ?? '', item.cardIdentityId ?? '', item.sourceVariantKey ?? ''].join('|');
}

function stableMovementSort(direction) {
  return (left, right) => {
    const movementDifference = direction === 'ascending'
      ? left.movementPercent - right.movementPercent
      : right.movementPercent - left.movementPercent;
    return movementDifference || stableKey(left).localeCompare(stableKey(right));
  };
}

function canonicalCurrentCards(cards) {
  const result = new Map();
  for (const card of [...cards].sort((left, right) => stableKey(left).localeCompare(stableKey(right)))) {
    const cardIdentityId = optionalText(card?.cardIdentityId);
    const currentPrice = finiteNumber(card?.currentPrice);
    if (!cardIdentityId || currentPrice == null || currentPrice < 0 || result.has(cardIdentityId)) continue;
    result.set(cardIdentityId, card);
  }
  return [...result.values()];
}

function groupCards(cards) {
  const groups = new Map();
  for (const card of cards) {
    const tcgCode = optionalText(card.tcgCode);
    const setCode = optionalText(card.setCode);
    if (!tcgCode || !setCode) continue;
    const key = `${tcgCode}|${setCode}`;
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, cards: group }));
}

function declaredSetTotal(cards) {
  const values = new Set(cards.map((card) => positiveInteger(card.expectedCardCount)).filter(Boolean));
  return values.size === 1 ? [...values][0] : null;
}

function cardMovement(card, periodKey) {
  const currentPrice = finiteNumber(card.currentPrice);
  const amount = finiteNumber(card.movement?.[periodKey]?.amount);
  const percent = finiteNumber(card.movement?.[periodKey]?.percent);
  if (currentPrice == null || amount == null || percent == null) return null;
  const baselinePrice = currentPrice - amount;
  if (!Number.isFinite(baselinePrice) || baselinePrice < 0) return null;
  return { currentPrice, baselinePrice, amount, percent };
}

function setPeriodEvidence(group, periodKey, minimumSetCoveragePct) {
  const first = group.cards[0];
  const expectedCardCount = declaredSetTotal(group.cards);
  const pricedCardCount = group.cards.length;
  const contributors = group.cards
    .map((card) => ({ card, movement: cardMovement(card, periodKey) }))
    .filter((item) => item.movement);
  const baselineCardCount = contributors.length;
  const currentPriceCoveragePct = percentage(pricedCardCount, expectedCardCount);
  const baselineCoveragePct = percentage(baselineCardCount, expectedCardCount);
  const qualifies = expectedCardCount != null
    && currentPriceCoveragePct >= minimumSetCoveragePct
    && baselineCoveragePct >= minimumSetCoveragePct;
  const currentBasketValue = qualifies
    ? roundMetric(contributors.reduce((sum, item) => sum + item.movement.currentPrice, 0))
    : null;
  const baselineBasketValue = qualifies
    ? roundMetric(contributors.reduce((sum, item) => sum + item.movement.baselinePrice, 0))
    : null;
  const movementAmount = qualifies ? roundMetric(currentBasketValue - baselineBasketValue) : null;
  const movementPercent = qualifies && baselineBasketValue > 0
    ? roundMetric((movementAmount / baselineBasketValue) * 100)
    : null;

  return Object.freeze({
    key: group.key,
    tcgCode: optionalText(first.tcgCode),
    setCode: optionalText(first.setCode),
    setName: optionalText(first.setName),
    expectedCardCount,
    pricedCardCount,
    baselineCardCount,
    currentPriceCoveragePct,
    baselineCoveragePct,
    currentBasketValue,
    baselineBasketValue,
    movementAmount,
    movementPercent,
    qualifies: qualifies && movementPercent != null,
    contributors,
  });
}

function publicSet(item) {
  return Object.freeze({
    key: item.key,
    tcgCode: item.tcgCode,
    setCode: item.setCode,
    setName: item.setName,
    expectedCardCount: item.expectedCardCount,
    pricedCardCount: item.pricedCardCount,
    baselineCardCount: item.baselineCardCount,
    currentPriceCoveragePct: item.currentPriceCoveragePct,
    baselineCoveragePct: item.baselineCoveragePct,
    currentBasketValue: item.currentBasketValue,
    baselineBasketValue: item.baselineBasketValue,
    movementAmount: item.movementAmount,
    movementPercent: item.movementPercent,
  });
}

function publicCard(item) {
  return Object.freeze({
    cardIdentityId: item.cardIdentityId,
    sourceVariantKey: item.sourceVariantKey,
    name: optionalText(item.name),
    tcgCode: optionalText(item.tcgCode),
    setCode: optionalText(item.setCode),
    setName: optionalText(item.setName),
    collectorNumber: optionalText(item.collectorNumber),
    currentPrice: roundMetric(item.currentPrice),
    movementAmount: roundMetric(item.movementAmount),
    movementPercent: roundMetric(item.movementPercent),
  });
}

function marketCondition({ risingSets, unchangedSets, fallingSets }, qualifyingSets) {
  if (qualifyingSets === 0) return 'insufficient_evidence';
  if (unchangedSets === qualifyingSets) return 'unchanged';
  if (risingSets / qualifyingSets >= 0.6) return 'broadly_rising';
  if (fallingSets / qualifyingSets >= 0.6) return 'broadly_falling';
  return 'mixed';
}

function buildPeriod(groups, cards, periodKey, minimumSetCoveragePct, rankingLimit) {
  const sets = groups.map((group) => setPeriodEvidence(group, periodKey, minimumSetCoveragePct));
  const qualifying = sets.filter((set) => set.qualifies);
  const declared = sets.filter((set) => set.expectedCardCount != null);
  const expectedCards = declared.reduce((sum, set) => sum + set.expectedCardCount, 0);
  const pricedCards = declared.reduce((sum, set) => sum + Math.min(set.pricedCardCount, set.expectedCardCount), 0);
  const baselineCards = declared.reduce((sum, set) => sum + Math.min(set.baselineCardCount, set.expectedCardCount), 0);
  const breadth = Object.freeze({
    risingSets: qualifying.filter((set) => set.movementPercent > 0).length,
    unchangedSets: qualifying.filter((set) => set.movementPercent === 0).length,
    fallingSets: qualifying.filter((set) => set.movementPercent < 0).length,
  });
  const headlinePercent = roundMetric(median(qualifying.map((set) => set.movementPercent)));
  const setRisers = qualifying.filter((set) => set.movementPercent > 0)
    .sort(stableMovementSort('descending')).slice(0, rankingLimit).map(publicSet);
  const setDecliners = qualifying.filter((set) => set.movementPercent < 0)
    .sort(stableMovementSort('ascending')).slice(0, rankingLimit).map(publicSet);
  const cardMovers = cards
    .map((card) => ({ card, movement: cardMovement(card, periodKey) }))
    .filter((item) => item.movement)
    .map(({ card, movement }) => ({
      ...card,
      movementAmount: movement.amount,
      movementPercent: movement.percent,
    }));

  const status = qualifying.length > 0 ? 'available' : 'building';
  const reason = status === 'available'
    ? null
    : sets.length === 0
      ? 'no_tracked_sets'
      : declared.length === 0
        ? 'set_totals_missing'
        : 'insufficient_set_coverage';

  return Object.freeze({
    status,
    reason,
    condition: marketCondition(breadth, qualifying.length),
    headlinePercent,
    breadth,
    coverage: Object.freeze({
      trackedSets: sets.length,
      qualifyingSets: qualifying.length,
      excludedSets: sets.length - qualifying.length,
      setsWithDeclaredTotals: declared.length,
      expectedCards,
      pricedCards,
      baselineCards,
      currentPriceCoveragePct: percentage(pricedCards, expectedCards),
      exactBaselineCoveragePct: percentage(baselineCards, expectedCards),
    }),
    setRisers: Object.freeze(setRisers),
    setDecliners: Object.freeze(setDecliners),
    cardRisers: Object.freeze(cardMovers.filter((card) => card.movementPercent > 0)
      .sort(stableMovementSort('descending')).slice(0, rankingLimit).map(publicCard)),
    cardDecliners: Object.freeze(cardMovers.filter((card) => card.movementPercent < 0)
      .sort(stableMovementSort('ascending')).slice(0, rankingLimit).map(publicCard)),
  });
}

export function buildMarketPulseDirection({
  cards = [],
  minimumSetCoveragePct = DEFAULT_MINIMUM_SET_COVERAGE_PCT,
  rankingLimit = DEFAULT_RANKING_LIMIT,
} = {}) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  if (!Number.isFinite(minimumSetCoveragePct) || minimumSetCoveragePct <= 0 || minimumSetCoveragePct > 100) {
    throw new TypeError('minimumSetCoveragePct must be between 0 and 100');
  }
  if (!Number.isInteger(rankingLimit) || rankingLimit < 1 || rankingLimit > 20) {
    throw new TypeError('rankingLimit must be an integer between 1 and 20');
  }

  const currentCards = canonicalCurrentCards(cards);
  const groups = groupCards(currentCards);
  return Object.freeze({
    schemaVersion: 'market-pulse-direction:1',
    method: 'median_qualifying_set_basket_return',
    minimumSetCoveragePct,
    rankingLimit,
    periods: Object.freeze(Object.fromEntries(PERIOD_KEYS.map((periodKey) => [
      periodKey,
      buildPeriod(groups, currentCards, periodKey, minimumSetCoveragePct, rankingLimit),
    ]))),
  });
}
