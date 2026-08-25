import { PostgresStore } from '../../stores/postgres-store.mjs';
import { buildVerifiedPokemonSetCrosswalk, syncVerifiedPokemonCatalogue } from './bulk-sync.mjs';
import { selectVerifiedSetCrosswalk } from './selection.mjs';
import { createPokemonTcgClient, createTcgdexClient } from './source-clients.mjs';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function csvSetIds(value) {
  if (value == null || value === '') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function positiveInt(value, fallback, max) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new TypeError(`Expected integer between 1 and ${max}, received ${value}`);
  }
  return parsed;
}

function compactMatchedSet(row) {
  return {
    tcgdexSetId: row.tcgdexSetId,
    pokemonTcgSetId: row.pokemonTcgSetId,
    canonicalSetId: row.setMatch.canonicalSetId,
    seriesName: row.setMatch.seriesName,
    setName: row.setMatch.setName,
    releasedAt: row.setMatch.releasedAt,
    printedTotal: row.setMatch.printedTotal,
    total: row.setMatch.total,
  };
}

function problemBreakdown(plan) {
  const rejectedByField = {};
  for (const row of plan.rejected || []) {
    const key = row.field || row.reason || row.status || 'unknown';
    rejectedByField[key] = (rejectedByField[key] || 0) + 1;
  }
  const sourceErrorsByStatus = {};
  for (const row of plan.sourceErrors || []) {
    const key = `${row.sourceName}:${row.status ?? 'unknown'}`;
    sourceErrorsByStatus[key] = (sourceErrorsByStatus[key] || 0) + 1;
  }
  return Object.freeze({
    rejectedByField,
    sourceErrorsByStatus,
    sourceErrorExamples: (plan.sourceErrors || []).slice(0, 20),
    ambiguousExamples: (plan.ambiguous || []).slice(0, 20),
    rejectedExamples: (plan.rejected || []).slice(0, 20),
    unmatchedTcgdexExamples: (plan.unmatchedTcgdex || []).slice(0, 20),
    unmatchedPokemonExamples: (plan.unmatchedPokemon || []).slice(0, 20),
  });
}

async function main() {
  const write = process.argv.includes('--write');
  const requestedSetIds = csvSetIds(argValue('sets'));
  const maxSets = positiveInt(argValue('max-sets'), requestedSetIds.length || 10, 100);
  const maxCardsPerChunk = positiveInt(argValue('max-cards'), 100, 250);
  const startAfterSetId = argValue('start-after');

  const tcgdexClient = createTcgdexClient({ languageCode: 'en' });
  const pokemonTcgClient = createPokemonTcgClient({ apiKey: process.env.POKEMON_TCG_API_KEY || null });
  const plan = await buildVerifiedPokemonSetCrosswalk({ tcgdexClient, pokemonTcgClient });
  const selection = selectVerifiedSetCrosswalk(plan, requestedSetIds);
  const report = {
    mode: write ? 'write' : 'plan',
    generatedAt: new Date().toISOString(),
    sourceCounts: plan.sourceCounts,
    counts: plan.counts,
    selection: {
      mode: selection.mode,
      requestedSetIds: selection.requestedSetIds,
      selectedCount: selection.selected.length,
      maxSets,
      startAfterSetId: startAfterSetId || null,
    },
    selectedSets: selection.selected.map(compactMatchedSet),
    matchedSets: plan.matched.map(compactMatchedSet),
    problems: problemBreakdown(plan),
    unresolved: {
      sourceErrors: plan.sourceErrors,
      ambiguous: plan.ambiguous,
      rejected: plan.rejected,
      unmatchedTcgdex: plan.unmatchedTcgdex,
      unmatchedPokemon: plan.unmatchedPokemon,
    },
  };

  if (!write) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!enabled(process.env.FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED)) {
    throw new Error('Bulk catalogue writes are disabled. Set FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true explicitly.');
  }
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for --write');

  const store = new PostgresStore(databaseUrl);
  const sync = await syncVerifiedPokemonCatalogue({
    store,
    tcgdexClient,
    pokemonTcgClient,
    crosswalk: selection.crosswalk,
    startAfterSetId,
    maxSets,
    maxCardsPerChunk,
  });
  console.log(JSON.stringify({ ...report, sync }, null, 2));
}

main().catch((error) => {
  const failure = {
    ok: false,
    error: error?.message || String(error),
    resume: error?.catalogueResume || null,
  };
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
