import { adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { reconcilePokemonCardCollections } from './pipeline.mjs';
import { reconcileSetEvidence } from './reconcile.mjs';
import { promoteMatchedCardEvidence } from './verification.mjs';
import { buildVerifiedCatalogueBatch } from './persistence.mjs';
import { buildVerifiedPokemonSetCrosswalk } from './bulk-sync.mjs';
import { selectVerifiedSetCrosswalk } from './selection.mjs';
import { createPokemonTcgSnapshotClient, createTcgdexSnapshotClient } from './snapshot-clients.mjs';

function cardRefId(ref) {
  const id = String(ref?.id || '').trim();
  return id || null;
}

function putUnique(map, row, label) {
  const existing = map.get(row.id);
  if (!existing) {
    map.set(row.id, row);
    return;
  }
  // Rows are built through the same deterministic persistence constructor with
  // one compiler timestamp, so byte-for-byte JSON equality is the safest
  // collision check. Do not use a JSON replacer here: it can hide nested fields.
  if (JSON.stringify(existing) !== JSON.stringify(row)) throw new Error(`${label} identity collision: ${row.id}`);
}

function emptyRows() {
  return {
    tcgs: new Map(),
    series: new Map(),
    sets: new Map(),
    setSourceMappings: new Map(),
    printings: new Map(),
    cardIdentities: new Map(),
    cardSourceMappings: new Map(),
    cardProvenance: new Map(),
  };
}

function mergeBatch(rows, batch) {
  putUnique(rows.tcgs, batch.tcg, 'TCG');
  putUnique(rows.series, batch.series, 'series');
  putUnique(rows.sets, batch.set, 'set');
  for (const row of batch.setSourceMappings) putUnique(rows.setSourceMappings, row, 'set source mapping');
  for (const row of batch.printings) putUnique(rows.printings, row, 'printing');
  for (const row of batch.cardIdentities) putUnique(rows.cardIdentities, row, 'card');
  for (const row of batch.cardSourceMappings) putUnique(rows.cardSourceMappings, row, 'card source mapping');
  for (const row of batch.cardProvenance) putUnique(rows.cardProvenance, row, 'card provenance');
}

async function compileSet({ tcgdexClient, pokemonTcgClient, pair, verifiedAt }) {
  const [rawTcgdexSet, rawPokemonSet] = await Promise.all([
    tcgdexClient.getSet(pair.tcgdexSetId),
    pokemonTcgClient.getSet(pair.pokemonTcgSetId),
  ]);
  const tcgdexSetEvidence = adaptTcgdexSet(rawTcgdexSet);
  const setMatch = reconcileSetEvidence(tcgdexSetEvidence, adaptPokemonTcgSet(rawPokemonSet));
  if (setMatch.status !== 'matched' || setMatch.canonicalSetId !== pair.setMatch.canonicalSetId) {
    throw new Error('verified set crosswalk changed inside snapshot compiler');
  }

  if (!Array.isArray(rawTcgdexSet.cards)) throw new TypeError('TCGdex snapshot set must contain cards[]');
  const refs = rawTcgdexSet.cards.map(cardRefId).filter(Boolean);
  if (!refs.length) throw new Error('set contains no source card records');

  const [tcgdexCards, pokemonCards] = await Promise.all([
    Promise.all(refs.map((id) => tcgdexClient.getCard(id))),
    pokemonTcgClient.listCardsBySet(pair.pokemonTcgSetId),
  ]);

  const cardResults = reconcilePokemonCardCollections({
    tcgdexCards,
    pokemonTcgCards: pokemonCards,
    setMatch,
    sourceSeriesCode: tcgdexSetEvidence.sourceSeriesCode,
    languageCode: 'en',
  });

  const diagnostics = Object.freeze({
    sourceCards: tcgdexCards.length,
    independentCards: pokemonCards.length,
    matchedCardRecords: cardResults.matched.length,
    conflicts: cardResults.conflicts.length,
    quarantined: cardResults.quarantined.length,
    unmatched: cardResults.unmatched.length,
  });

  const problems = [];
  if (tcgdexCards.length !== pokemonCards.length) problems.push('source_card_count_mismatch');
  if (cardResults.matched.length !== tcgdexCards.length) problems.push('not_all_source_cards_reconciled');
  if (cardResults.conflicts.length) problems.push('card_conflicts_present');
  if (cardResults.quarantined.length) problems.push('quarantined_cards_present');
  if (cardResults.unmatched.length) problems.push('unmatched_cards_present');
  if (problems.length) {
    return Object.freeze({ status: 'rejected', reasons: Object.freeze(problems), diagnostics, batch: null });
  }

  const promotions = cardResults.matched.map((match) => promoteMatchedCardEvidence(match, { verifiedAt }));
  const rejectedPromotion = promotions.find((promotion) => promotion.status !== 'verified');
  if (rejectedPromotion) throw new Error(`catalogue promotion failed: ${rejectedPromotion.reason || 'unknown'}`);

  const batch = buildVerifiedCatalogueBatch({ setMatch, promotions, verifiedAt });
  return Object.freeze({
    status: 'verified',
    reasons: Object.freeze([]),
    diagnostics: Object.freeze({
      ...diagnostics,
      verifiedCardIdentities: batch.cardIdentities.length,
      verifiedPrintings: batch.printings.length,
    }),
    batch,
  });
}

export async function compilePokemonCatalogueSnapshots({
  tcgdexSnapshot,
  pokemonTcgSnapshot,
  requestedTcgdexSetIds = null,
  verifiedAt = Date.now(),
} = {}) {
  const tcgdexClient = createTcgdexSnapshotClient(tcgdexSnapshot);
  const pokemonTcgClient = createPokemonTcgSnapshotClient(pokemonTcgSnapshot);
  const crosswalk = await buildVerifiedPokemonSetCrosswalk({ tcgdexClient, pokemonTcgClient });
  const selection = requestedTcgdexSetIds?.length
    ? selectVerifiedSetCrosswalk(crosswalk, requestedTcgdexSetIds)
    : { selected: crosswalk.matched, crosswalk };

  const rows = emptyRows();
  const verifiedSets = [];
  const rejectedSets = [];

  for (const pair of selection.selected) {
    try {
      const result = await compileSet({ tcgdexClient, pokemonTcgClient, pair, verifiedAt });
      const summary = {
        tcgdexSetId: pair.tcgdexSetId,
        pokemonTcgSetId: pair.pokemonTcgSetId,
        canonicalSetId: pair.setMatch.canonicalSetId,
        seriesName: pair.setMatch.seriesName,
        setName: pair.setMatch.setName,
        ...result.diagnostics,
      };
      if (result.status === 'verified') {
        mergeBatch(rows, result.batch);
        verifiedSets.push(Object.freeze(summary));
      } else {
        rejectedSets.push(Object.freeze({ ...summary, reasons: result.reasons }));
      }
    } catch (error) {
      rejectedSets.push(Object.freeze({
        tcgdexSetId: pair.tcgdexSetId,
        pokemonTcgSetId: pair.pokemonTcgSetId,
        canonicalSetId: pair.setMatch.canonicalSetId,
        seriesName: pair.setMatch.seriesName,
        setName: pair.setMatch.setName,
        reasons: Object.freeze(['compiler_error']),
        error: error?.message || String(error),
      }));
    }
  }

  const artifact = Object.freeze({
    format: 'fatedrop-pokemon-catalogue-v1',
    generatedAt: new Date(verifiedAt).toISOString(),
    verifiedAt,
    sources: Object.freeze({
      tcgdex: Object.freeze({ ...(tcgdexClient.snapshotMeta || {}) }),
      pokemonTcg: Object.freeze({ ...(pokemonTcgClient.snapshotMeta || {}) }),
    }),
    crosswalk: Object.freeze({ sourceCounts: crosswalk.sourceCounts, counts: crosswalk.counts }),
    compilation: Object.freeze({
      requestedSetCount: selection.selected.length,
      verifiedSetCount: verifiedSets.length,
      rejectedSetCount: rejectedSets.length,
      verifiedSets: Object.freeze(verifiedSets),
      rejectedSets: Object.freeze(rejectedSets),
    }),
    counts: Object.freeze({
      tcgs: rows.tcgs.size,
      series: rows.series.size,
      sets: rows.sets.size,
      setSourceMappings: rows.setSourceMappings.size,
      printings: rows.printings.size,
      cardIdentities: rows.cardIdentities.size,
      cardSourceMappings: rows.cardSourceMappings.size,
      cardProvenance: rows.cardProvenance.size,
    }),
    rows: Object.freeze({
      tcgs: Object.freeze([...rows.tcgs.values()]),
      series: Object.freeze([...rows.series.values()]),
      sets: Object.freeze([...rows.sets.values()]),
      setSourceMappings: Object.freeze([...rows.setSourceMappings.values()]),
      printings: Object.freeze([...rows.printings.values()]),
      cardIdentities: Object.freeze([...rows.cardIdentities.values()]),
      cardSourceMappings: Object.freeze([...rows.cardSourceMappings.values()]),
      cardProvenance: Object.freeze([...rows.cardProvenance.values()]),
    }),
  });

  return artifact;
}
