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

function percent(numerator, denominator) {
  if (denominator === 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function coverageBand(value) {
  if (value === 100) return 'complete';
  if (value >= 90) return 'high';
  if (value >= 70) return 'medium';
  if (value > 0) return 'low';
  return 'none';
}

function coverageSummary(expectedCount, pricedCount) {
  const safeExpected = Number(expectedCount);
  const safePriced = Number(pricedCount);
  const unpricedCount = Math.max(0, safeExpected - safePriced);
  const coveragePercent = percent(safePriced, safeExpected);
  return Object.freeze({
    expectedCount: safeExpected,
    pricedCount: safePriced,
    unpricedCount,
    coveragePercent,
    coverageBand: coverageBand(coveragePercent),
    complete: unpricedCount === 0,
  });
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
      knownSetValue: 0,
      ownedExpectedCount: null,
      ownedPricedCount: null,
      ownedUnpricedCount: null,
      ownedPriceCoveragePercent: null,
      ownedValue: null,
      knownOwnedValue: null,
      missingExpectedCount: null,
      missingPricedCount: null,
      missingUnpricedCount: null,
      missingPriceCoveragePercent: null,
      missingValue: null,
      knownMissingValue: null,
    });
  }

  const setId = completeness.setId;
  const printingIds = new Set(
    canonicalCards
      .filter((card) => card?.verificationStatus === 'verified' && text(card.setId) === setId)
      .map((card) => text(card.printingId))
      .filter(Boolean),
  );
  const owned = new Set(
    [...ownedPrintingIds]
      .map(text)
      .filter((printingId) => printingId && printingIds.has(printingId)),
  );
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

  let knownSetValue = 0;
  let knownOwnedValue = 0;
  let knownMissingValue = 0;
  let ownedPricedCount = 0;
  let missingPricedCount = 0;
  const unpricedPrintingIds = [];

  for (const printingId of printingIds) {
    const isOwned = owned.has(printingId);
    const value = values.get(printingId);
    if (!value) {
      unpricedPrintingIds.push(printingId);
      continue;
    }

    knownSetValue += value.amount;
    if (isOwned) {
      knownOwnedValue += value.amount;
      ownedPricedCount += 1;
    } else {
      knownMissingValue += value.amount;
      missingPricedCount += 1;
    }
  }

  const setCoverage = coverageSummary(printingIds.size, values.size);
  const ownedCoverage = coverageSummary(owned.size, ownedPricedCount);
  const missingExpectedCount = printingIds.size - owned.size;
  const missingCoverage = coverageSummary(missingExpectedCount, missingPricedCount);

  return Object.freeze({
    status: setCoverage.complete ? 'available' : values.size > 0 ? 'partial' : 'unavailable',
    reason: setCoverage.complete ? null : values.size > 0 ? 'price_coverage_incomplete' : 'no_price_evidence',
    setId,
    currencyCode: code,

    expectedCount: setCoverage.expectedCount,
    pricedCount: setCoverage.pricedCount,
    unpricedCount: setCoverage.unpricedCount,
    priceCoveragePercent: setCoverage.coveragePercent,
    priceCoverageBand: setCoverage.coverageBand,
    fullSetValue: setCoverage.complete ? roundMoney(knownSetValue) : null,
    knownSetValue: roundMoney(knownSetValue),

    ownedExpectedCount: ownedCoverage.expectedCount,
    ownedPricedCount: ownedCoverage.pricedCount,
    ownedUnpricedCount: ownedCoverage.unpricedCount,
    ownedPriceCoveragePercent: ownedCoverage.coveragePercent,
    ownedPriceCoverageBand: ownedCoverage.coverageBand,
    ownedValue: ownedCoverage.complete ? roundMoney(knownOwnedValue) : null,
    knownOwnedValue: roundMoney(knownOwnedValue),

    missingExpectedCount: missingCoverage.expectedCount,
    missingPricedCount: missingCoverage.pricedCount,
    missingUnpricedCount: missingCoverage.unpricedCount,
    missingPriceCoveragePercent: missingCoverage.coveragePercent,
    missingPriceCoverageBand: missingCoverage.coverageBand,
    missingValue: missingCoverage.complete ? roundMoney(knownMissingValue) : null,
    knownMissingValue: roundMoney(knownMissingValue),

    unpricedPrintingIds: Object.freeze(unpricedPrintingIds.sort()),
  });
}
