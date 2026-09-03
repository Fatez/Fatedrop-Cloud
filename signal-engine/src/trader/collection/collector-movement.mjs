import { computeFateValueMovement } from '../value/value-movement.mjs';

function setIndex(summary) {
  return new Map((summary?.sets || []).map((set) => [set.setId, set]));
}

function gameIndex(summary) {
  return new Map((summary?.games || []).map((game) => [game.tcgCode, game]));
}

function missingIndex(set) {
  return new Map((set?.missingCards || []).map((card) => [card.printingId ?? card.fateCardId, card]));
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

function missingCardMovement(currentSet, baselineSet, currencyCode, currentAsOf, baselineAsOf) {
  const baselineCards=missingIndex(baselineSet);
  return Object.freeze((currentSet?.missingCards||[]).map((card)=>{
    const baseline=baselineCards.get(card.printingId??card.fateCardId);
    return Object.freeze({
      fateCardId:card.fateCardId,
      printingId:card.printingId,
      name:card.name??null,
      collectorNumber:card.collectorNumber??null,
      currentPrice:card.fatePrice?.amount??null,
      baselinePrice:baseline?.fatePrice?.amount??null,
      movement:movement(card.fatePrice?.amount,baseline?.fatePrice?.amount,currencyCode,currentAsOf,baselineAsOf),
    });
  }));
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
      games: Object.freeze([]),
      sets: Object.freeze([]),
    });
  }

  const baselineSets = setIndex(baselineSummary);
  const sets = (currentSummary?.sets || []).map((currentSet) => {
    const baselineSet=baselineSets.get(currentSet.setId);
    return Object.freeze({
      setId: currentSet.setId,
      setName: currentSet.setName ?? null,
      tcgCode: currentSet.tcgCode ?? null,
      value: setValueMovement(currentSet,baselineSet,currencyCode,currentAsOf,baselineAsOf),
      missingCards:missingCardMovement(currentSet,baselineSet,currencyCode,currentAsOf,baselineAsOf),
    });
  });
  const baselineGames=gameIndex(baselineSummary);
  const games=(currentSummary?.games||[]).map((currentGame)=>Object.freeze({
    tcgCode:currentGame.tcgCode,
    collection:movement(
      currentGame.collection?.totalValue,
      baselineGames.get(currentGame.tcgCode)?.collection?.totalValue,
      currencyCode,currentAsOf,baselineAsOf,
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
    ...games.map((game)=>game.collection),
    ...sets.flatMap((set) => [
      set.value.fullSet,set.value.owned,set.value.missing,
      ...set.missingCards.map((card)=>card.movement),
    ]),
  ].filter((item) => item.status === 'available').length;

  return Object.freeze({
    status: availableSignals > 0 ? 'available' : 'unavailable',
    reason: availableSignals > 0 ? null : 'complete_historical_value_unavailable',
    baselineAsOf,
    collection,
    games:Object.freeze(games),
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
