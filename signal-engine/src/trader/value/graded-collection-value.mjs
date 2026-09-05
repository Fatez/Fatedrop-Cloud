function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('graded value amount must be non-negative');
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

export function makeGradedValuationKey({ fateCardId, gradingCompany, gradeLabel } = {}) {
  const card = text(fateCardId);
  const company = text(gradingCompany).toUpperCase();
  const grade = text(gradeLabel).toUpperCase();
  return card && company && grade ? `${card}\u0000${company}\u0000${grade}` : null;
}

/**
 * Grade-specific collection valuation.
 *
 * A slab is valued only when evidence matches the exact canonical card,
 * grading company and grade label. Raw-card evidence is never accepted here.
 */
export function computeFateGradedCollectionValue({
  collectionItems,
  gradedValues = [],
  currencyCode,
} = {}) {
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');
  if (!Array.isArray(gradedValues)) throw new TypeError('gradedValues must be an array');
  const code = currency(currencyCode);
  const latestByGrade = new Map();

  for (const raw of gradedValues) {
    if (raw?.valuationKind !== 'graded-market') continue;
    if (currency(raw.currencyCode) !== code) continue;
    const key = makeGradedValuationKey(raw);
    if (!key) continue;
    const candidate = Object.freeze({
      amount: amount(raw.amount),
      observedAt: timestamp(raw.observedAt),
      sourceName: text(raw.sourceName) || null,
      evidenceCount: Number.isInteger(raw.evidenceCount) && raw.evidenceCount >= 0 ? raw.evidenceCount : null,
    });
    const existing = latestByGrade.get(key);
    if (!existing || candidate.observedAt > existing.observedAt) latestByGrade.set(key, candidate);
  }

  const activeSlabs = collectionItems.filter((item) => item
    && item.status !== 'removed'
    && Number(item.quantity ?? 1) > 0
    && String(item.copyState || '').toLowerCase() === 'graded');
  let pricedUnits = 0;
  let knownValue = 0;
  const unpricedItems = [];

  for (const item of activeSlabs) {
    const key = makeGradedValuationKey({
      fateCardId: item.fateCardId,
      gradingCompany: item.grading?.gradingCompany,
      gradeLabel: item.grading?.gradeLabel,
    });
    if (!key) {
      unpricedItems.push(Object.freeze({
        itemId: text(item.id) || null,
        fateCardId: text(item.fateCardId),
        quantity: 1,
        reason: 'grading_identity_incomplete',
      }));
      continue;
    }
    const value = latestByGrade.get(key);
    if (!value) {
      unpricedItems.push(Object.freeze({
        itemId: text(item.id) || null,
        fateCardId: text(item.fateCardId),
        quantity: 1,
        reason: 'graded_price_evidence_unavailable',
      }));
      continue;
    }
    pricedUnits += 1;
    knownValue += value.amount;
  }

  const totalUnits = activeSlabs.length;
  const unpricedUnits = totalUnits - pricedUnits;
  const priceCoveragePercent = totalUnits === 0 ? 100 : Number(((pricedUnits / totalUnits) * 100).toFixed(1));
  const completePricing = unpricedUnits === 0;
  return Object.freeze({
    status: completePricing ? 'available' : pricedUnits > 0 ? 'partial' : 'unavailable',
    reason: completePricing ? null : pricedUnits > 0 ? 'graded_price_coverage_incomplete' : 'graded_price_evidence_unavailable',
    valuationKind: 'graded-market',
    currencyCode: code,
    itemCount: totalUnits,
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
