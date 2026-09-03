import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';

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
  if (!Number.isFinite(number) || number < 0) throw new TypeError('printing value amount must be non-negative');
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

export function computeFateSetValue({
  set,
  canonicalCards,
  printingValues,
  ownedPrintingIds = [],
  currencyCode,
} = {}) {
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (!Array.isArray(printingValues)) throw new TypeError('printingValues must be an array');
  const code = currency(currencyCode);
  const completeness = assessCanonicalSetCompleteness({ set, canonicalCards });

  if (completeness.status !== 'complete') {
    return Object.freeze({
      status: 'unavailable',
      reason: completeness.reason,
      setId: completeness.setId,
      currencyCode: code,
      expectedCount: completeness.expectedTotal,
      pricedCount: 0,
      unpricedCount: completeness.expectedTotal,
      priceCoveragePercent: 0,
      priceCoverageBand: 'none',
      fullSetValue: null,
      ownedValue: null,
      missingValue: null,
    });
  }

  const setId = completeness.setId;
  const printingIds = new Set(
    canonicalCards
      .filter((card) => card?.verificationStatus === 'verified' && text(card.setId) === setId)
      .map((card) => text(card.printingId))
      .filter(Boolean),
  );
  const owned = new Set([...ownedPrintingIds].map(text).filter(Boolean));
  const values = new Map();

  for (const raw of printingValues) {
    const printingId = text(raw?.printingId);
    if (!printingId || !printingIds.has(printingId)) continue;
    if (currency(raw.currencyCode) !== code) continue;
    const candidate = Object.freeze({
      printingId,
      amount: amount(raw.amount),
      observedAt: timestamp(raw.observedAt),
      sourceName: text(raw.sourceName) || null,
      evidenceCount: Number.isInteger(raw.evidenceCount) && raw.evidenceCount >= 0 ? raw.evidenceCount : null,
    });
    const existing = values.get(printingId);
    if (!existing || candidate.observedAt > existing.observedAt) values.set(printingId, candidate);
  }

  let fullSetKnownValue = 0;
  let ownedKnownValue = 0;
  let missingKnownValue = 0;
  const unpricedPrintingIds = [];

  for (const printingId of printingIds) {
    const value = values.get(printingId);
    if (!value) {
      unpricedPrintingIds.push(printingId);
      continue;
    }
    fullSetKnownValue += value.amount;
    if (owned.has(printingId)) ownedKnownValue += value.amount;
    else missingKnownValue += value.amount;
  }

  const expectedCount = printingIds.size;
  const pricedCount = values.size;
  const unpricedCount = expectedCount - pricedCount;
  const priceCoveragePercent = Number(((pricedCount / expectedCount) * 100).toFixed(1));
  const completePricing = unpricedCount === 0;

  return Object.freeze({
    status: completePricing ? 'available' : pricedCount > 0 ? 'partial' : 'unavailable',
    reason: completePricing ? null : pricedCount > 0 ? 'price_coverage_incomplete' : 'no_price_evidence',
    setId,
    currencyCode: code,
    expectedCount,
    pricedCount,
    unpricedCount,
    priceCoveragePercent,
    priceCoverageBand: coverageBand(priceCoveragePercent),
    fullSetValue: completePricing ? roundMoney(fullSetKnownValue) : null,
    knownSetValue: roundMoney(fullSetKnownValue),
    ownedValue: roundMoney(ownedKnownValue),
    missingValue: completePricing ? roundMoney(missingKnownValue) : null,
    knownMissingValue: roundMoney(missingKnownValue),
    unpricedPrintingIds: Object.freeze(unpricedPrintingIds.sort()),
  });
}
