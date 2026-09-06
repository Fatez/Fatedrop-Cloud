function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function percent(value) {
  return Number(Number(value || 0).toFixed(1));
}

function rawQuantities(collectionItems) {
  const quantities = new Map();
  for (const item of Array.isArray(collectionItems) ? collectionItems : []) {
    if (!item || item.status === 'removed') continue;
    if (String(item.copyState || 'raw').toLowerCase() !== 'raw') continue;
    const id = text(item.fateCardId);
    const quantity = Number(item.quantity ?? 1);
    if (!id || !Number.isFinite(quantity) || quantity <= 0) continue;
    quantities.set(id, (quantities.get(id) || 0) + quantity);
  }
  return quantities;
}

function comparison(currentUnitPrice, movement, quantity) {
  const movementPercent = finite(movement?.percent);
  const current = finite(currentUnitPrice);
  const factor = movementPercent == null ? null : 1 + (movementPercent / 100);
  if (movement?.available !== true || current == null || current < 0 || factor == null || factor <= 0) {
    return Object.freeze({ status: 'building', reason: movement?.reason || 'owned_price_history_insufficient', baselineValue: null, currentValue: null, movementAmount: null, movementPercent: null });
  }
  const currentValue = current * quantity;
  const baselineValue = currentValue / factor;
  return Object.freeze({
    status: 'available',
    reason: null,
    baselineValue: money(baselineValue),
    currentValue: money(currentValue),
    movementAmount: money(currentValue - baselineValue),
    movementPercent: percent(movementPercent),
  });
}

function aggregatePeriod(holdings, key, totalCopies) {
  const eligible = holdings.filter((holding) => holding[key].status === 'available');
  const eligibleCopies = eligible.reduce((sum, holding) => sum + holding.quantity, 0);
  if (!eligible.length) {
    return Object.freeze({
      status: 'building',
      reason: 'owned_price_history_insufficient',
      eligibleIdentities: 0,
      eligibleCopies: 0,
      coveragePercent: totalCopies ? 0 : 100,
      baselineValue: null,
      currentValue: null,
      movementAmount: null,
      movementPercent: null,
    });
  }
  const baselineValue = eligible.reduce((sum, holding) => sum + Number(holding[key].baselineValue || 0), 0);
  const currentValue = eligible.reduce((sum, holding) => sum + Number(holding[key].currentValue || 0), 0);
  return Object.freeze({
    status: 'available',
    reason: eligibleCopies < totalCopies ? 'price_history_coverage_incomplete' : null,
    eligibleIdentities: eligible.length,
    eligibleCopies,
    coveragePercent: totalCopies ? percent((eligibleCopies / totalCopies) * 100) : 100,
    baselineValue: money(baselineValue),
    currentValue: money(currentValue),
    movementAmount: money(currentValue - baselineValue),
    movementPercent: baselineValue > 0 ? percent(((currentValue - baselineValue) / baselineValue) * 100) : null,
  });
}

function historyResult(histories, quantities, holdings, totalCopies, knownValue) {
  const byDay = new Map();
  const included = new Set();
  for (const history of Array.isArray(histories) ? histories : []) {
    const id = text(history?.cardIdentityId);
    const quantity = quantities.get(id);
    if (!id || !quantity || history?.available !== true || !Array.isArray(history.points)) continue;
    let contributed = false;
    for (const point of history.points) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text(point?.marketDay))) continue;
      const amount = finite(point?.amount);
      if (amount == null || amount < 0) continue;
      const row = byDay.get(point.marketDay) || { marketDay: point.marketDay, knownValue: 0, pricedCopies: 0 };
      row.knownValue += amount * quantity;
      row.pricedCopies += quantity;
      byDay.set(point.marketDay, row);
      contributed = true;
    }
    if (contributed) included.add(id);
  }
  const points = [...byDay.values()]
    .sort((left, right) => left.marketDay.localeCompare(right.marketDay))
    .map((row) => Object.freeze({
      marketDay: row.marketDay,
      knownValue: money(row.knownValue),
      pricedCopies: row.pricedCopies,
      totalCopies,
      coveragePercent: totalCopies ? percent((row.pricedCopies / totalCopies) * 100) : 100,
    }));
  const currentValues = new Map(holdings.map((holding) => [holding.cardIdentityId, holding.currentKnownValue]));
  const includedCurrentValue = [...included].reduce((sum, id) => sum + Number(currentValues.get(id) || 0), 0);
  return Object.freeze({
    status: points.length >= 2 ? 'available' : 'building',
    reason: points.length >= 2 ? (included.size < quantities.size ? 'history_identity_limit_or_coverage_incomplete' : null) : 'owned_price_history_insufficient',
    pointPolicy: 'stored_market_days_only_no_interpolation',
    includedIdentities: included.size,
    ownedIdentities: quantities.size,
    currentValueCoveragePercent: knownValue > 0 ? percent((includedCurrentValue / knownValue) * 100) : totalCopies ? 0 : 100,
    points: Object.freeze(points),
  });
}

function setRows(holdings, totalKnownValue) {
  const grouped = new Map();
  for (const holding of holdings) {
    const key = holding.setId || `unknown:${holding.tcgCode || 'tcg'}`;
    const group = grouped.get(key) || {
      setId: holding.setId,
      setName: holding.setName,
      tcgCode: holding.tcgCode,
      holdings: [],
    };
    group.holdings.push(holding);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    const totalCopies = group.holdings.reduce((sum, holding) => sum + holding.quantity, 0);
    const pricedCopies = group.holdings.filter((holding) => holding.currentUnitPrice != null).reduce((sum, holding) => sum + holding.quantity, 0);
    const currentKnownValue = group.holdings.reduce((sum, holding) => sum + Number(holding.currentKnownValue || 0), 0);
    return Object.freeze({
      setId: group.setId,
      setName: group.setName,
      tcgCode: group.tcgCode,
      uniqueCards: group.holdings.length,
      totalCopies,
      pricedCopies,
      unpricedCopies: totalCopies - pricedCopies,
      priceCoveragePercent: totalCopies ? percent((pricedCopies / totalCopies) * 100) : 100,
      currentKnownValue: money(currentKnownValue),
      collectionSharePercent: totalKnownValue > 0 ? percent((currentKnownValue / totalKnownValue) * 100) : 0,
      d7: aggregatePeriod(group.holdings, 'd7', totalCopies),
      d30: aggregatePeriod(group.holdings, 'd30', totalCopies),
    });
  }).sort((left, right) => right.currentKnownValue - left.currentKnownValue || String(left.setName || '').localeCompare(String(right.setName || '')));
}

export function buildFateCollectorIntelligence({
  collectionItems = [],
  cards = [],
  prices = [],
  histories = [],
  currencyCode = 'GBP',
} = {}) {
  const quantities = rawQuantities(collectionItems);
  const cardsById = new Map((Array.isArray(cards) ? cards : []).map((card) => [text(card?.fateCardId ?? card?.id), card]).filter(([id]) => id));
  const pricesById = new Map((Array.isArray(prices) ? prices : []).map((price) => [text(price?.cardIdentityId), price]).filter(([id]) => id));
  const holdings = [...quantities.entries()].map(([cardIdentityId, quantity]) => {
    const card = cardsById.get(cardIdentityId);
    const price = pricesById.get(cardIdentityId);
    const currentUnitPrice = price?.available === true ? finite(price.price?.amount) : null;
    return Object.freeze({
      cardIdentityId,
      name: card?.name ?? null,
      tcgCode: card?.tcgCode ?? null,
      setId: card?.setId ?? null,
      setName: card?.setName ?? null,
      collectorNumber: card?.collectorNumber ?? null,
      rarity: card?.rarity ?? null,
      variantCode: card?.variantCode ?? null,
      languageCode: card?.languageCode ?? null,
      imageUrl: card?.imageUrl ?? null,
      thumbnailUrl: card?.thumbnailUrl ?? null,
      quantity,
      currentUnitPrice,
      currentKnownValue: currentUnitPrice == null ? null : money(currentUnitPrice * quantity),
      currencyCode: price?.price?.currencyCode ?? currencyCode,
      d7: comparison(currentUnitPrice, price?.movement?.d7, quantity),
      d30: comparison(currentUnitPrice, price?.movement?.d30, quantity),
    });
  }).sort((left, right) => Number(right.currentKnownValue || -1) - Number(left.currentKnownValue || -1) || String(left.name || '').localeCompare(String(right.name || '')));

  const totalCopies = holdings.reduce((sum, holding) => sum + holding.quantity, 0);
  const pricedCopies = holdings.filter((holding) => holding.currentUnitPrice != null).reduce((sum, holding) => sum + holding.quantity, 0);
  const currentKnownValue = holdings.reduce((sum, holding) => sum + Number(holding.currentKnownValue || 0), 0);
  const topFiveValue = holdings.slice(0, 5).reduce((sum, holding) => sum + Number(holding.currentKnownValue || 0), 0);
  const sets = setRows(holdings, currentKnownValue);
  const representedSets = new Set(holdings.map((holding) => holding.setId).filter(Boolean)).size;
  const unpricedCopies = totalCopies - pricedCopies;

  return Object.freeze({
    schemaVersion: 'collector-intelligence:1',
    scope: 'owned_raw_cards_only',
    currencyCode,
    snapshot: Object.freeze({
      status: unpricedCopies === 0 ? 'available' : pricedCopies > 0 ? 'partial' : totalCopies === 0 ? 'available' : 'unavailable',
      reason: unpricedCopies === 0 ? null : pricedCopies > 0 ? 'price_coverage_incomplete' : 'no_price_evidence',
      currentKnownValue: money(currentKnownValue),
      totalCopies,
      pricedCopies,
      unpricedCopies,
      priceCoveragePercent: totalCopies ? percent((pricedCopies / totalCopies) * 100) : 100,
      uniqueCards: holdings.length,
      setsRepresented: representedSets,
      topFiveValue: money(topFiveValue),
      topFiveSharePercent: currentKnownValue > 0 ? percent((topFiveValue / currentKnownValue) * 100) : 0,
    }),
    periods: Object.freeze({
      d7: aggregatePeriod(holdings, 'd7', totalCopies),
      d30: aggregatePeriod(holdings, 'd30', totalCopies),
    }),
    history: historyResult(histories, quantities, holdings, totalCopies, currentKnownValue),
    cards: Object.freeze(holdings),
    sets: Object.freeze(sets),
    evidence: Object.freeze({
      ownershipPolicy: 'raw_only',
      movementQuantityPolicy: 'same_current_owned_quantities_at_both_endpoints',
      concentrationIdentityPolicy: 'unique_exact_card_identity_with_quantity_weighted_value',
      acquisitionCostUsed: false,
      missingEvidencePolicy: 'unknown_not_zero',
    }),
  });
}
