const SUPPORTED_PRICE_FIELDS = Object.freeze([
  'marketPrice',
  'lowPrice',
  'trendPrice',
  'avg1d',
  'avg7d',
  'avg30d',
  'avgLifetime',
  'excellentPlusLow',
]);

const WINDOWS = Object.freeze({
  d1: 1,
  d7: 7,
  d30: 30,
});

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function requirePriceField(value) {
  const priceField = requireText(value, 'priceField');
  if (!SUPPORTED_PRICE_FIELDS.includes(priceField)) {
    throw new TypeError(`priceField must be one of: ${SUPPORTED_PRICE_FIELDS.join(', ')}`);
  }
  return priceField;
}

function requireCurrency(value) {
  const currencyCode = requireText(value, 'currencyCode').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new TypeError('currencyCode must be an ISO-style 3-letter code');
  }
  return currencyCode;
}

function normaliseLabel(value, fallback, field) {
  const text = optionalText(value) ?? optionalText(fallback);
  if (!text) throw new TypeError(`${field} is required`);
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '-');
}

function normaliseDay(value, field = 'marketDay') {
  const text = requireText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`${field} must be YYYY-MM-DD`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${field} must be a valid UTC calendar day`);
  }
  return text;
}

function subtractUtcDays(day, days) {
  const date = new Date(`${normaliseDay(day)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function finitePrice(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function roundMetric(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function indexCardIdentities(cardIdentities) {
  if (cardIdentities instanceof Map) return new Map(cardIdentities);
  if (Array.isArray(cardIdentities)) {
    return new Map(cardIdentities.map((identity) => {
      const id = optionalText(identity?.id) ?? optionalText(identity?.fateCardId);
      if (!id) throw new TypeError('card identity id is required');
      return [id, identity];
    }));
  }
  if (cardIdentities && typeof cardIdentities === 'object') {
    return new Map(Object.entries(cardIdentities));
  }
  throw new TypeError('cardIdentities must be a Map, array, or object');
}

function observationTime(observation) {
  const value = observation?.sourceEffectiveAt ?? observation?.observedAt ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function chooseLatest(existing, candidate) {
  if (!existing) return candidate;
  return observationTime(candidate) >= observationTime(existing) ? candidate : existing;
}

function laneKey(observation) {
  return [
    requireText(observation?.cardIdentityId, 'cardIdentityId'),
    requireText(observation?.sourceVariantKey, 'sourceVariantKey'),
  ].join('|');
}

function movement(currentPrice, baselinePrice) {
  if (currentPrice == null || baselinePrice == null) return null;
  const amount = currentPrice - baselinePrice;
  return Object.freeze({
    amount: roundMetric(amount),
    percent: baselinePrice === 0 ? null : roundMetric((amount / baselinePrice) * 100),
  });
}

function aggregateMovement(items, eligibleCount, windowKey) {
  const changes = items
    .map((item) => item.movement[windowKey])
    .filter(Boolean);
  const amounts = changes.map((change) => change.amount).filter(Number.isFinite);
  const percents = changes.map((change) => change.percent).filter(Number.isFinite);
  return Object.freeze({
    contributors: changes.length,
    percentContributors: percents.length,
    eligible: eligibleCount,
    coveragePct: eligibleCount === 0 ? null : roundMetric((changes.length / eligibleCount) * 100),
    meanAmount: roundMetric(mean(amounts)),
    medianAmount: roundMetric(median(amounts)),
    meanPercent: roundMetric(mean(percents)),
    medianPercent: roundMetric(median(percents)),
    rising: changes.filter((change) => change.amount > 0).length,
    falling: changes.filter((change) => change.amount < 0).length,
    flat: changes.filter((change) => change.amount === 0).length,
  });
}

function aggregateGroup(items, identitySelector) {
  const eligibleCount = items.length;
  const distinctCards = new Set(items.map((item) => item.cardIdentityId));
  const group = {
    ...identitySelector(items[0]),
    currentCardCount: distinctCards.size,
    currentLaneCount: eligibleCount,
    movement: Object.fromEntries(
      Object.keys(WINDOWS).map((windowKey) => [windowKey, aggregateMovement(items, eligibleCount, windowKey)]),
    ),
  };
  return Object.freeze(group);
}

function aggregateBy(items, keySelector, identitySelector) {
  const groups = new Map();
  for (const item of items) {
    const key = keySelector(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((groupItems) => aggregateGroup(groupItems, identitySelector));
}

function stableSort(left, right, fields) {
  for (const field of fields) {
    const a = left[field] ?? '';
    const b = right[field] ?? '';
    const compared = String(a).localeCompare(String(b));
    if (compared !== 0) return compared;
  }
  return 0;
}

export const MARKET_PULSE_PRICE_FIELDS = SUPPORTED_PRICE_FIELDS;
export const MARKET_PULSE_WINDOWS = WINDOWS;

export function buildMarketPulseSnapshot({
  observations = [],
  cardIdentities,
  sourceName,
  priceField,
  currencyCode,
  marketSegmentKey = 'default',
  conditionCode = 'unspecified',
  tcgCode = null,
  setCode = null,
  generatedAt = Date.now(),
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  if (!Number.isFinite(Number(generatedAt)) || Number(generatedAt) <= 0) {
    throw new TypeError('generatedAt must be a positive timestamp');
  }

  const identityIndex = indexCardIdentities(cardIdentities);
  const basis = Object.freeze({
    sourceName: requireText(sourceName, 'sourceName'),
    priceField: requirePriceField(priceField),
    currencyCode: requireCurrency(currencyCode),
    marketSegmentKey: normaliseLabel(marketSegmentKey, 'default', 'marketSegmentKey'),
    conditionCode: normaliseLabel(conditionCode, 'unspecified', 'conditionCode'),
  });
  const scope = Object.freeze({
    tcgCode: optionalText(tcgCode),
    setCode: optionalText(setCode),
  });

  const unresolvedIdentityIds = new Set();
  const filtered = [];

  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') continue;
    if (observation.sourceName !== basis.sourceName) continue;
    if (String(observation.currencyCode ?? '').toUpperCase() !== basis.currencyCode) continue;
    if (normaliseLabel(observation.marketSegmentKey, 'default', 'marketSegmentKey') !== basis.marketSegmentKey) continue;
    if (normaliseLabel(observation.conditionCode, 'unspecified', 'conditionCode') !== basis.conditionCode) continue;

    const cardIdentityId = optionalText(observation.cardIdentityId);
    if (!cardIdentityId) continue;
    const identity = identityIndex.get(cardIdentityId);
    if (!identity) {
      unresolvedIdentityIds.add(cardIdentityId);
      continue;
    }
    if (scope.tcgCode && identity.tcgCode !== scope.tcgCode) continue;
    if (scope.setCode && identity.setCode !== scope.setCode) continue;

    filtered.push({
      observation,
      identity,
      marketDay: normaliseDay(observation.marketDay),
    });
  }

  const anchorMarketDay = filtered.length === 0
    ? null
    : filtered.map((item) => item.marketDay).sort().at(-1);

  if (!anchorMarketDay) {
    return Object.freeze({
      schemaVersion: 'market-pulse:1a',
      generatedAt: Number(generatedAt),
      anchorMarketDay: null,
      basis,
      scope,
      evidence: Object.freeze({
        observationsConsidered: 0,
        mappedLaneCount: 0,
        currentLaneCount: 0,
        currentCardCount: 0,
        unresolvedIdentityCount: unresolvedIdentityIds.size,
        staleLaneCount: 0,
      }),
      movement: Object.fromEntries(
        Object.keys(WINDOWS).map((windowKey) => [windowKey, aggregateMovement([], 0, windowKey)]),
      ),
      games: Object.freeze([]),
      sets: Object.freeze([]),
      cards: Object.freeze([]),
    });
  }

  const days = new Set([
    anchorMarketDay,
    ...Object.values(WINDOWS).map((daysBack) => subtractUtcDays(anchorMarketDay, daysBack)),
  ]);
  const lanes = new Map();

  for (const item of filtered) {
    const key = laneKey(item.observation);
    const lane = lanes.get(key) ?? {
      cardIdentityId: item.observation.cardIdentityId,
      sourceVariantKey: item.observation.sourceVariantKey,
      identity: item.identity,
      byDay: new Map(),
    };
    if (days.has(item.marketDay)) {
      lane.byDay.set(item.marketDay, chooseLatest(lane.byDay.get(item.marketDay), item.observation));
    }
    lanes.set(key, lane);
  }

  const cards = [];
  let staleLaneCount = 0;

  for (const lane of lanes.values()) {
    const currentObservation = lane.byDay.get(anchorMarketDay);
    const currentPrice = finitePrice(currentObservation?.[basis.priceField]);
    if (!currentObservation || currentPrice == null) {
      staleLaneCount += 1;
      continue;
    }

    const itemMovement = {};
    for (const [windowKey, daysBack] of Object.entries(WINDOWS)) {
      const baselineDay = subtractUtcDays(anchorMarketDay, daysBack);
      const baselineObservation = lane.byDay.get(baselineDay);
      const baselinePrice = finitePrice(baselineObservation?.[basis.priceField]);
      itemMovement[windowKey] = movement(currentPrice, baselinePrice);
    }

    cards.push(Object.freeze({
      cardIdentityId: lane.cardIdentityId,
      sourceVariantKey: lane.sourceVariantKey,
      name: optionalText(lane.identity.name),
      tcgCode: optionalText(lane.identity.tcgCode),
      seriesCode: optionalText(lane.identity.seriesCode),
      setCode: optionalText(lane.identity.setCode),
      collectorNumber: optionalText(lane.identity.collectorNumber),
      anchorMarketDay,
      currentPrice: roundMetric(currentPrice),
      movement: Object.freeze(itemMovement),
    }));
  }

  cards.sort((left, right) => stableSort(left, right, ['tcgCode', 'setCode', 'collectorNumber', 'cardIdentityId', 'sourceVariantKey']));

  const movementSummary = Object.freeze(Object.fromEntries(
    Object.keys(WINDOWS).map((windowKey) => [windowKey, aggregateMovement(cards, cards.length, windowKey)]),
  ));

  const games = aggregateBy(
    cards,
    (item) => item.tcgCode ?? 'unknown',
    (item) => ({ tcgCode: item.tcgCode }),
  ).sort((left, right) => stableSort(left, right, ['tcgCode']));

  const sets = aggregateBy(
    cards,
    (item) => `${item.tcgCode ?? 'unknown'}|${item.setCode ?? 'unknown'}`,
    (item) => ({ tcgCode: item.tcgCode, setCode: item.setCode }),
  ).sort((left, right) => stableSort(left, right, ['tcgCode', 'setCode']));

  return Object.freeze({
    schemaVersion: 'market-pulse:1a',
    generatedAt: Number(generatedAt),
    anchorMarketDay,
    basis,
    scope,
    evidence: Object.freeze({
      observationsConsidered: filtered.length,
      mappedLaneCount: lanes.size,
      currentLaneCount: cards.length,
      currentCardCount: new Set(cards.map((item) => item.cardIdentityId)).size,
      unresolvedIdentityCount: unresolvedIdentityIds.size,
      staleLaneCount,
    }),
    movement: movementSummary,
    games: Object.freeze(games),
    sets: Object.freeze(sets),
    cards: Object.freeze(cards),
  });
}
