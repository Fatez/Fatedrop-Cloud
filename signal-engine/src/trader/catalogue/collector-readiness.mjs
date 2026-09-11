import { assessCanonicalSetCompleteness } from './completeness.mjs';
import { listVerifiedCardsFromStore, listVerifiedCardSetsFromStore, listVerifiedPrintingsFromStore } from './store.mjs';
import { requireKnownTcg } from '../tcg-registry.mjs';

export async function auditCollectorCatalogueFromStore(store, {
  tcgCode,
  setLimit = 1000,
} = {}) {
  const capability = requireKnownTcg(tcgCode);
  const sets = await listVerifiedCardSetsFromStore(store, { tcgCode: capability.code, limit:setLimit });
  const results = [];

  for (const set of sets) {
    const [canonicalCards, canonicalPrintings] = await Promise.all([
      listVerifiedCardsFromStore(store, { setId:set.id, limit:500 }),
      listVerifiedPrintingsFromStore(store, { setId:set.id, limit:1000 }),
    ]);
    const completeness = assessCanonicalSetCompleteness({ set, canonicalCards, canonicalPrintings: canonicalPrintings.length ? canonicalPrintings : null });
    results.push(Object.freeze({
      tcgCode: capability.code,
      setId: set.id,
      setName: set.name,
      seriesId: set.seriesId,
      seriesName: set.seriesName ?? null,
      releasedAt: set.releasedAt ?? null,
      ...completeness,
      collectorReady: completeness.status === 'complete',
    }));
  }

  const summary = {
    tcgCode: capability.code,
    totalVerifiedSets: results.length,
    collectorReadySets: 0,
    incompleteSets: 0,
    conflictSets: 0,
    unknownSets: 0,
  };
  for (const result of results) {
    if (result.status === 'complete') summary.collectorReadySets += 1;
    else if (result.status === 'incomplete') summary.incompleteSets += 1;
    else if (result.status === 'conflict') summary.conflictSets += 1;
    else summary.unknownSets += 1;
  }

  return Object.freeze({
    summary: Object.freeze(summary),
    sets: Object.freeze(results),
  });
}
