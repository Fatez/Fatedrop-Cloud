function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

function positiveQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1) throw new TypeError('collection item quantity must be a positive integer');
  return quantity;
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('card value amount must be non-negative');
  return number;
}

function timestamp(value) {
  if (value == null) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('observedAt must be a non-negative timestamp');
  return number;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function coverageBand(percent) {
  if (percent === 100) return 'complete';
  if (percent >= 90) return 'high';
  if (percent >= 70) return 'medium';
  if (percent > 0) return 'low';
  return 'none';
}

export function computeFateCollectionValue({
  collectionItems,
  cardValues,
  currencyCode,
} = {}) {
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');
  if (!Array.isArray(cardValues)) throw new TypeError('cardValues must be an array');
  const code = currency(currencyCode);

  const latestByCard = new Map();
  for (const raw of cardValues) {
    const fateCardId = text(raw?.fateCardId);
    if (!fateCardId) continue;
    if (currency(raw.currencyCode) !== code) continue;
    if (raw.valuationKind != null && raw.valuationKind !== 'raw-market') continue;

    const candidate = Object.freeze({
      fateCardId,
      amount: amount(raw.amount),
      observedAt: timestamp(raw.observedAt),
      sourceName: text(raw.sourceName) || null,
      evidenceCount: Number.isInteger(raw.evidenceCount) && raw.evidenceCount >= 0 ? raw.evidenceCount : null,
    });
    const existing = latestByCard.get(fateCardId);
    if (!existing || candidate.observedAt > existing.observedAt) latestByCard.set(fateCardId, candidate);
  }

  let totalUnits = 0;
  let pricedUnits = 0;
  let knownValue = 0;
  const activeItems = [];
  const unpricedItems = [];

  for (const item of collectionItems) {
    if (!item || item.status === 'removed') continue;
    const itemId = text(item.id) || null;
    const fateCardId = text(item.fateCardId);
    if (!fateCardId) throw new TypeError('active collection item fateCardId is required');
    const quantity = positiveQuantity(item.quantity ?? 1);
    totalUnits += quantity;
    activeItems.push(item);

    if (String(item.copyState || 'raw').toLowerCase() === 'graded') {
      unpricedItems.push(Object.freeze({
        itemId,
        fateCardId,
        quantity,
        reason: 'graded_valuation_unavailable',
      }));
      continue;
    }

    const value = latestByCard.get(fateCardId);
    if (!value) {
      unpricedItems.push(Object.freeze({
        itemId,
        fateCardId,
        quantity,
        reason: 'price_evidence_unavailable',
      }));
      continue;
    }

    pricedUnits += quantity;
    knownValue += value.amount * quantity;
  }

  const unpricedUnits = totalUnits - pricedUnits;
  const priceCoveragePercent = totalUnits === 0
    ? 100
    : Number(((pricedUnits / totalUnits) * 100).toFixed(1));
  const completePricing = unpricedUnits === 0;

  return Object.freeze({
    status: completePricing ? 'available' : pricedUnits > 0 ? 'partial' : totalUnits === 0 ? 'available' : 'unavailable',
    reason: completePricing ? null : pricedUnits > 0 ? 'price_coverage_incomplete' : 'no_price_evidence',
    currencyCode: code,
    itemCount: activeItems.length,
    totalUnits,
    pricedUnits,
    unpricedUnits,
    priceCoveragePercent,
    priceCoverageBand: coverageBand(priceCoveragePercent),
    totalValue: completePricing ? roundMoney(knownValue) : null,
    knownValue: roundMoney(knownValue),
    unpricedItems: Object.freeze(unpricedItems),
  });
}
