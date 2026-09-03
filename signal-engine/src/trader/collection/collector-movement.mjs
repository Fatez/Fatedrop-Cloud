import { computeFateValueMovement } from '../value/value-movement.mjs';

function setIndex(summary) {
  return new Map((summary?.sets || []).map((set) => [set.setId, set]));
}

function movement(currentValue, baselineValue, currencyCode, currentAsOf, baselineAsOf) {
  return computeFateValueMovement({
    currentValue,
    baselineValue,
    currencyCode,
    currentAsOf,
    baselineAsOf,
  });
}

function setValueMovement(currentSet, baselineSet, currencyCode, currentAsOf, baselineAsOf) {
  const current = currentSet?.value ?? null;
  const baseline = baselineSet?.value ?? null;
  return Object.freeze({
    fullSet: movement(current?.fullSetValue, baseline?.fullSetValue, currencyCode, currentAsOf, baselineAsOf),
    owned: movement(current?.ownedValue, baseline?.ownedValue, currencyCode, currentAsOf, baselineAsOf),
    missing: movement(current?.missingValue, baseline?.missingValue, currencyCode, currentAsOf, baselineAsOf),
  });
}

function windowMovement({ currentSummary, baselineSummary, currencyCode, currentAsOf, baselineAsOf }) {
  if (!baselineSummary) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'baseline_summary_unavailable',
      baselineAsOf,
      collection: movement(currentSummary?.collection?.totalValue, null, currencyCode, currentAsOf, baselineAsOf),
      sets: Object.freeze([]),
    });
  }

  const baselineSets = setIndex(baselineSummary);
  const sets = (currentSummary?.sets || []).map((currentSet) => Object.freeze({
    setId: currentSet.setId,
    setName: currentSet.setName ?? null,
    tcgCode: currentSet.tcgCode ?? null,
    value: setValueMovement(
      currentSet,
      baselineSets.get(currentSet.setId),
      currencyCode,
      currentAsOf,
      baselineAsOf,
    ),
  }));
  const collection = movement(
    currentSummary?.collection?.totalValue,
    baselineSummary?.collection?.totalValue,
    currencyCode,
    currentAsOf,
    baselineAsOf,
  );
  const availableSignals = [
    collection,
    ...sets.flatMap((set) => [set.value.fullSet, set.value.owned, set.value.missing]),
  ].filter((item) => item.status === 'available').length;

  return Object.freeze({
    status: availableSignals > 0 ? 'available' : 'unavailable',
    reason: availableSignals > 0 ? null : 'complete_historical_value_unavailable',
    baselineAsOf,
    collection,
    sets: Object.freeze(sets),
  });
}

/**
 * Movement is intentionally calculated by repricing the collector's current
 * holdings at historical market evidence. It measures market movement of what
 * the user owns now; it does not pretend to reconstruct which cards they owned
 * 7/30 days ago. Historical ownership can be added later from collection events
 * as a separate portfolio-performance view.
 */
export function computeFateCollectorMovement({
  currentSummary,
  sevenDaySummary = null,
  thirtyDaySummary = null,
  currencyCode,
  currentAsOf,
  sevenDayAsOf,
  thirtyDayAsOf,
} = {}) {
  if (!currentSummary || typeof currentSummary !== 'object') throw new TypeError('currentSummary is required');
  return Object.freeze({
    schemaVersion: 1,
    basis: 'current-holdings-repriced',
    currencyCode,
    currentAsOf,
    sevenDay: windowMovement({
      currentSummary,
      baselineSummary: sevenDaySummary,
      currencyCode,
      currentAsOf,
      baselineAsOf: sevenDayAsOf,
    }),
    thirtyDay: windowMovement({
      currentSummary,
      baselineSummary: thirtyDaySummary,
      currencyCode,
      currentAsOf,
      baselineAsOf: thirtyDayAsOf,
    }),
  });
}
