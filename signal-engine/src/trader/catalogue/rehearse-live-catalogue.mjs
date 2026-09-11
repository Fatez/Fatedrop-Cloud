import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getPrintingArtworkCoverageFromStore } from './artwork-store.mjs';
import { buildVerifiedPokemonSetCrosswalk, syncVerifiedPokemonCatalogue } from './bulk-sync.mjs';
import { diagnoseChecklistPrintingTail } from './checklist-diagnostics.mjs';
import { createTcgdexClient } from './source-clients.mjs';
import { validateRehearsalTarget, assertRehearsalCounts } from './rehearsal-guard.mjs';

// The repository is the API publisher's versioned data; matching rules are unchanged.
async function repositoryPokemonClient(root) {
  if (!root) throw new Error('Pinned Pokemon TCG repository is required');
  const sets = JSON.parse(await readFile(root + '/sets/en.json', 'utf8'));
  if (!Array.isArray(sets)) throw new Error('Invalid repository set listing');
  const byId = new Map(sets.map(set => [set.id, set]));
  if (byId.size !== sets.length) throw new Error('Duplicate repository set IDs');
  return {
    async listSets() { return sets; },
    async getSet(id) {
      const set = byId.get(id);
      if (!set) throw new Error('Repository set missing: ' + id);
      return set;
    },
    async listCardsBySet(id) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid set ID');
      const set = await this.getSet(id);
      const cards = JSON.parse(await readFile(root + '/cards/en/' + id + '.json', 'utf8'));
      if (!Array.isArray(cards)) throw new Error('Invalid repository cards');
      const seen = new Set();
      return cards.map(card => {
        if (!card.id?.startsWith(id + '-') || seen.has(card.id))
          throw new Error('Conflicting repository card ID: ' + card.id);
        seen.add(card.id);
        if (card.set && card.set.id !== id) throw new Error('Conflicting embedded set');
        return {...card, set};
      });
    }
  };
}

// These sets are deliberately held by the existing Astra-era first-edition safety rule.
// Do not weaken that adapter rule here: edition+finish composition needs its own model.
const INTENTIONAL_FIRST_EDITION_QUARANTINE_SET_IDS = new Set([
  'base2', 'base3', 'base5', 'gym1', 'neo1', 'neo2', 'neo3', 'neo4',
]);

// No production credential is accepted, fetched or needed by this rehearsal.
const connectionString = process.env.CATALOGUE_REHEARSAL_DATABASE_URL;
validateRehearsalTarget(connectionString);
const pool = new Pool({ connectionString, max: 2 });
const store = { pool: async () => pool };
const verifiedAt = Date.now();
const output = process.env.RUNNER_TEMP || '.';
const progress = { mode: 'isolated_rehearsal', productionWrites: false, sets: [] };
const save = () => writeFile(`${output}/catalogue-rehearsal.json`, JSON.stringify(progress, null, 2));

// Replay uses exactly the same fetched evidence; no second provider crawl.
function cached(client, { sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const result = {};
  for (const [name, method] of Object.entries(client)) {
    if (typeof method !== 'function') { result[name] = method; continue; }
    const cache = new Map();
    result[name] = (...args) => {
      const key = JSON.stringify(args);
      if (!cache.has(key)) {
        const request = (async () => {
          for (let attempt = 0; ; attempt += 1) {
            try { return await method.apply(client, args); }
            catch (error) {
              if (attempt >= 2 || ![429, 500, 502, 503, 504, 'network'].includes(error?.status)) throw error;
              await sleep(15_000 * (attempt + 1));
            }
          }
        })();
        cache.set(key, request);
        request.catch(() => { if (cache.get(key) === request) cache.delete(key); });
      }
      return cache.get(key);
    };
  }
  return result;
}

async function counts() {
  const {rows} = await pool.query(`SELECT
    (SELECT count(*)::int FROM fatedrop_card_sets WHERE verification_status='verified') verified_sets,
    (SELECT count(*)::int FROM fatedrop_card_printings) printings,
    (SELECT count(*)::int FROM fatedrop_card_identities WHERE verification_status='verified') verified_identities,
    (SELECT count(*)::int FROM fatedrop_card_source_mappings) source_mappings,
    (SELECT count(*)::int FROM fatedrop_card_identities c LEFT JOIN fatedrop_card_sets s ON s.id=c.set_id WHERE s.id IS NULL) orphan_sets,
    (SELECT count(*)::int FROM fatedrop_card_identities c LEFT JOIN fatedrop_card_printings p ON p.id=c.printing_id WHERE p.id IS NULL) orphan_printings,
    (SELECT count(*)::int FROM fatedrop_card_source_mappings m LEFT JOIN fatedrop_card_identities c ON c.id=m.card_identity_id WHERE c.id IS NULL) orphan_mappings,
    (SELECT count(*)::int FROM (SELECT printing_id,variant_code,language_code FROM fatedrop_card_identities GROUP BY 1,2,3 HAVING count(*)>1) d) duplicate_identities`);
  return rows[0];
}

function classifyZeroSavedSets(sets) {
  const intentional = [];
  const unexplained = [];
  for (const set of sets.filter(entry => (entry?.savedCards || 0) === 0)) {
    const fullyQuarantined = set.sourceCardsProcessed > 0
      && set.quarantined === set.sourceCardsProcessed
      && set.matchedCardRecords === 0
      && set.unmatchedCards === 0;
    if (INTENTIONAL_FIRST_EDITION_QUARANTINE_SET_IDS.has(set.tcgdexSetId) && fullyQuarantined) intentional.push(set.tcgdexSetId);
    else unexplained.push(set.tcgdexSetId);
  }
  return { intentional, unexplained };
}

try {
  for (const file of ['fate-trader-card-identity.sql','fate-trader-catalogue-crosswalk.sql'])
    await pool.query(await readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8'));
  assert.equal((await counts()).verified_identities, 0, 'Rehearsal database must start empty');
  const tcgdexClient = cached(createTcgdexClient({languageCode:'en'}));
  const pokemonTcgClient = cached(await repositoryPokemonClient(process.env.POKEMON_TCG_DATA_ROOT));
  const crosswalk = await buildVerifiedPokemonSetCrosswalk({tcgdexClient,pokemonTcgClient});
  assert.ok(crosswalk.counts.matched >= 132);
  assert.equal(crosswalk.counts.ambiguous, 0);
  progress.crosswalk = crosswalk.counts;
  progress.sourceRevision = process.env.POKEMON_TCG_DATA_REVISION;
  progress.sourceRepository = 'PokemonTCG/pokemon-tcg-data';
  await save();
  progress.sourceFailures = [];
  progress.setBlockers = [];
  // Diagnostic completion runs collect all per-set failures. Production workflows
  // keep their existing fail-fast behaviour; failed diagnostics never pass activation.
  const collectAllBlockers = process.env.CATALOGUE_COLLECT_ALL_BLOCKERS === 'true';
  for (const pair of crosswalk.matched) {
    try {
      const scoped = {...crosswalk, matched:[pair]};
      const result = await syncVerifiedPokemonCatalogue({store,tcgdexClient,pokemonTcgClient,crosswalk:scoped,maxSets:1,maxCardsPerChunk:250,verifiedAt});
      assert.equal(result.status,'complete');
      const completed = result.sets[0];
      const needsChecklistDiagnosis = (completed?.savedPrintings || 0) !== (completed?.sourceCardsProcessed || 0);
      const checklistUnresolved = needsChecklistDiagnosis
        ? await diagnoseChecklistPrintingTail({tcgdexClient,pokemonTcgClient,pair})
        : [];
      const recorded = checklistUnresolved.length ? {...completed, checklistUnresolved} : completed;
      progress.sets.push(recorded);
      await save();
      console.log(JSON.stringify({event:'set_rehearsed',completed:progress.sets.length,total:crosswalk.matched.length,...recorded}));
    } catch (error) {
      const sourceFailure = [429, 500, 502, 503, 504, 'network'].includes(error?.status);
      if (!sourceFailure && !collectAllBlockers) throw error;
      const blocker = {setId:pair.tcgdexSetId,status:error.status ?? null,sourceUrl:error.sourceUrl ?? null,message:error.message};
      if (sourceFailure) progress.sourceFailures.push(blocker);
      else progress.setBlockers.push(blocker);
      await save();
      console.error(JSON.stringify({event:sourceFailure ? 'set_source_unavailable' : 'set_blocked',...blocker}));
    }
  }
  progress.saved = await counts();
  progress.artwork = await getPrintingArtworkCoverageFromStore(store);
  const zeroSaved = classifyZeroSavedSets(progress.sets);
  progress.intentionalQuarantineSetIds = zeroSaved.intentional;
  progress.unexplainedZeroSavedSetIds = zeroSaved.unexplained;
  await save();
  if (progress.setBlockers.length) throw new Error('Catalogue set blockers remain: ' + progress.setBlockers.map(x => x.setId).join(', '));
  if (progress.sourceFailures.length) throw new Error('Catalogue source failures remain: ' + progress.sourceFailures.map(x => x.setId).join(', '));
  assertRehearsalCounts(progress.saved, {
    matchedSets: crosswalk.matched.length,
    completedSets: progress.sets.length,
    intentionalQuarantineSets: zeroSaved.intentional.length,
    unexplainedZeroSavedSetIds: zeroSaved.unexplained,
  });
  assert.equal(
    progress.artwork.withThumbnail,
    progress.artwork.total,
    `Thumbnail coverage incomplete: ${progress.artwork.withThumbnail}/${progress.artwork.total}`,
  );
  // Replay every set: duplicate identities/mappings must not inflate saved totals.
  for (const pair of crosswalk.matched)
    await syncVerifiedPokemonCatalogue({store,tcgdexClient,pokemonTcgClient,crosswalk:{...crosswalk,matched:[pair]},maxSets:1,maxCardsPerChunk:250,verifiedAt});
  progress.replayed = await counts();
  progress.replayedArtwork = await getPrintingArtworkCoverageFromStore(store);
  assert.deepEqual(progress.replayed,progress.saved);
  assert.deepEqual(progress.replayedArtwork,progress.artwork);
  progress.status = 'passed';
  console.log(JSON.stringify({event:'rehearsal_passed',...progress.saved,thumbnailPrintings:progress.artwork.withThumbnail,thumbnailCoverageComplete:true,replayCountsUnchanged:true,productionWrites:false}));
} catch (error) {
  progress.status = 'failed';
  progress.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await save();
  await pool.end();
}
