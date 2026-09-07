import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresStore } from '../../stores/postgres-store.mjs';
import { persistVerifiedCatalogueBatch } from './store.mjs';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function boundedInt(value, fallback, min, max, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  return parsed;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requireText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function assertUnique(rows, keyFn, label) {
  const seen = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) throw new Error(`${label} contains an empty key`);
    const prior = seen.get(key);
    if (prior && prior !== row.id) throw new Error(`${label} collision at ${key}`);
    seen.set(key, row.id);
  }
}

export function validateActivationBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new TypeError('activation bundle is required');
  if (bundle.format !== 'fatedrop-catalogue-activation-bundle-v1') throw new Error(`unsupported activation bundle format: ${bundle.format || 'missing'}`);
  if (bundle.safety?.exactOnly !== true || bundle.safety?.fuzzyMatching !== false || bundle.safety?.verifiedSetsOnly !== true) throw new Error('activation bundle safety contract is not exact-only verified catalogue data');

  const tcgs = requireArray(bundle.tcgs, 'tcgs');
  const series = requireArray(bundle.series, 'series');
  const sets = requireArray(bundle.sets, 'sets');
  const setSourceMappings = requireArray(bundle.setSourceMappings, 'setSourceMappings');
  const printings = requireArray(bundle.printings, 'printings');
  const cardIdentities = requireArray(bundle.cardIdentities, 'cardIdentities');
  const cardSourceMappings = requireArray(bundle.cardSourceMappings, 'cardSourceMappings');
  const cardProvenance = requireArray(bundle.cardProvenance, 'cardProvenance');

  if (!sets.length || !cardIdentities.length) throw new Error('activation bundle contains no catalogue rows');
  if (sets.length !== Number(bundle.counts?.sets)) throw new Error('activation set count mismatch');
  if (printings.length !== Number(bundle.counts?.printings)) throw new Error('activation printing count mismatch');
  if (cardIdentities.length !== Number(bundle.counts?.cardIdentities)) throw new Error('activation identity count mismatch');
  if (cardSourceMappings.length !== Number(bundle.counts?.cardSourceMappings)) throw new Error('activation source mapping count mismatch');
  if (cardProvenance.length !== Number(bundle.counts?.cardProvenance)) throw new Error('activation provenance count mismatch');

  const tcgById = new Map(tcgs.map((row) => [row.id, row]));
  const seriesById = new Map(series.map((row) => [row.id, row]));
  const setById = new Map(sets.map((row) => [row.id, row]));
  const printingById = new Map(printings.map((row) => [row.id, row]));
  const cardById = new Map(cardIdentities.map((row) => [row.id, row]));

  if (tcgs.some((row) => row.code !== 'pokemon')) throw new Error('activation bundle contains a non-Pokemon TCG row');
  if (series.some((row) => row.verificationStatus !== 'verified') || sets.some((row) => row.verificationStatus !== 'verified') || printings.some((row) => row.verificationStatus !== 'verified') || cardIdentities.some((row) => row.verificationStatus !== 'verified')) throw new Error('activation bundle contains a non-verified canonical row');
  for (const row of series) if (!tcgById.has(row.tcgId)) throw new Error(`orphan series ${row.id}`);
  for (const row of sets) if (!tcgById.has(row.tcgId) || !seriesById.has(row.seriesId)) throw new Error(`orphan set ${row.id}`);
  for (const row of setSourceMappings) if (!setById.has(row.setId)) throw new Error(`orphan set source mapping ${row.id}`);
  for (const row of printings) if (!setById.has(row.setId) || !seriesById.has(row.seriesId) || !tcgById.has(row.tcgId)) throw new Error(`orphan printing ${row.id}`);
  for (const row of cardIdentities) {
    if (!setById.has(row.setId) || !printingById.has(row.printingId) || !seriesById.has(row.seriesId) || !tcgById.has(row.tcgId)) throw new Error(`orphan card identity ${row.id}`);
    if (printingById.get(row.printingId).setId !== row.setId) throw new Error(`card/printing set mismatch ${row.id}`);
  }
  for (const row of cardSourceMappings) if (!cardById.has(row.cardIdentityId)) throw new Error(`orphan card source mapping ${row.id}`);
  for (const row of cardProvenance) if (!cardById.has(row.cardIdentityId)) throw new Error(`orphan card provenance ${row.id}`);

  assertUnique(setSourceMappings, (row) => `${requireText(row.sourceName, 'setSourceMappings.sourceName')}|${requireText(row.sourceRecordId, 'setSourceMappings.sourceRecordId')}`, 'set source mapping');
  assertUnique(cardSourceMappings, (row) => `${requireText(row.sourceName, 'cardSourceMappings.sourceName')}|${requireText(row.sourceRecordId, 'cardSourceMappings.sourceRecordId')}|${requireText(row.sourceVariantKey, 'cardSourceMappings.sourceVariantKey')}`, 'card source mapping');
  return Object.freeze({ sets: sets.length, printings: printings.length, cardIdentities: cardIdentities.length, cardSourceMappings: cardSourceMappings.length, cardProvenance: cardProvenance.length });
}

export function splitActivationBundleBySet(bundle) {
  validateActivationBundle(bundle);
  const tcgById = new Map(bundle.tcgs.map((row) => [row.id, row]));
  const seriesById = new Map(bundle.series.map((row) => [row.id, row]));
  const printingsBySet = new Map();
  const cardsBySet = new Map();
  const setMappingsBySet = new Map();
  const cardMappingsByCard = new Map();
  const provenanceByCard = new Map();
  const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const row of bundle.printings) push(printingsBySet, row.setId, row);
  for (const row of bundle.cardIdentities) push(cardsBySet, row.setId, row);
  for (const row of bundle.setSourceMappings) push(setMappingsBySet, row.setId, row);
  for (const row of bundle.cardSourceMappings) push(cardMappingsByCard, row.cardIdentityId, row);
  for (const row of bundle.cardProvenance) push(provenanceByCard, row.cardIdentityId, row);
  return bundle.sets.map((set) => {
    const cards = cardsBySet.get(set.id) || [];
    const cardIds = new Set(cards.map((row) => row.id));
    const batch = {
      tcg: tcgById.get(set.tcgId), series: seriesById.get(set.seriesId), set,
      setSourceMappings: setMappingsBySet.get(set.id) || [], printings: printingsBySet.get(set.id) || [], cardIdentities: cards,
      cardSourceMappings: [...cardIds].flatMap((id) => cardMappingsByCard.get(id) || []), cardProvenance: [...cardIds].flatMap((id) => provenanceByCard.get(id) || []),
    };
    if (!batch.printings.length || !batch.cardIdentities.length) throw new Error(`verified set ${set.id} has no verified card data`);
    return batch;
  });
}

async function main() {
  const artifactPath = argValue('artifact');
  if (!artifactPath) throw new Error('--artifact=<activation-bundle.json> is required');
  const bundle = JSON.parse(await readFile(resolve(artifactPath), 'utf8'));
  const validation = validateActivationBundle(bundle);
  const allBatches = splitActivationBundleBySet(bundle);
  const limit = boundedInt(argValue('limit'), allBatches.length, 1, allBatches.length, 'limit');
  const batches = allBatches.slice(0, limit);
  const write = process.argv.includes('--write');
  const concurrency = boundedInt(argValue('concurrency'), 1, 1, 8, 'concurrency');

  if (!write) {
    console.log(JSON.stringify({ mode: 'validate', artifactPath: resolve(artifactPath), validation, selectedBatches: batches.length, totalBatches: allBatches.length, concurrency }, null, 2));
    return;
  }
  if (!enabled(process.env.FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED)) throw new Error('Catalogue activation writes are disabled. Set FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true explicitly.');
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for --write');

  const store = new PostgresStore(databaseUrl);
  const results = new Array(batches.length);
  let cursor = 0;
  async function worker(workerId) {
    while (true) {
      const index = cursor++;
      if (index >= batches.length) return;
      const batch = batches[index];
      const result = await persistVerifiedCatalogueBatch(store, batch);
      results[index] = { setId: batch.set.id, setName: batch.set.name, savedPrintings: Number(result.savedPrintings || 0), savedCards: Number(result.savedCards || 0) };
      console.log(JSON.stringify({ event: 'set_persisted', workerId, setId: batch.set.id, setName: batch.set.name, savedPrintings: result.savedPrintings, savedCards: result.savedCards }));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
  const savedPrintings = results.reduce((sum, row) => sum + row.savedPrintings, 0);
  const savedCards = results.reduce((sum, row) => sum + row.savedCards, 0);
  console.log(JSON.stringify({ mode: 'write', concurrency, selectedSetsPersisted: results.length, totalBundleSets: allBatches.length, savedPrintings, savedCards, expected: validation }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
