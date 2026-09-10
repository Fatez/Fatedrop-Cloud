import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FINISH_CODES = Object.freeze([
  ['normal', 'normal'],
  ['holo', 'holo'],
  ['reverse', 'reverse'],
]);

async function jsonFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path);
    }
  }
  await walk(root);
  return out.sort();
}

function exactSnapshotFinishes(snapshot, { namespace, sourceVersion }) {
  if (snapshot?.schemaVersion !== 1) return null;
  if (snapshot?.namespace !== namespace || snapshot?.sourceVersion !== sourceVersion) return null;
  if (snapshot?.method !== 'getCard') return null;
  const card = snapshot?.payload;
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  if (!card.id || !card.set?.id || !card.variants || typeof card.variants !== 'object' || Array.isArray(card.variants)) return null;
  for (const key of ['normal', 'holo', 'reverse', 'firstEdition']) {
    if (typeof card.variants[key] !== 'boolean') return null;
  }
  if (card.variants.firstEdition) return null;
  const finishes = FINISH_CODES.filter(([key]) => card.variants[key] === true).map(([, value]) => value);
  if (!finishes.length) return null;
  return { id: String(card.id), setId: String(card.set.id), finishes };
}

export async function reconcilePinnedFinishEvidence(census, {
  snapshotDirectory,
  namespace = 'tcgdex-en',
  sourceVersion = 'tcgdex-en-v1',
} = {}) {
  if (census?.format !== 'fatedrop-primary-source-census-v1' || !Array.isArray(census.cards)) throw new Error('Pinned primary census required');
  if (!snapshotDirectory) throw new Error('snapshotDirectory is required');

  const exactById = new Map();
  let snapshotsInspected = 0;
  let exactCardSnapshots = 0;
  let conflictingSnapshots = 0;
  for (const file of await jsonFiles(snapshotDirectory)) {
    let parsed;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); }
    catch { continue; }
    snapshotsInspected += 1;
    const evidence = exactSnapshotFinishes(parsed, { namespace, sourceVersion });
    if (!evidence) continue;
    exactCardSnapshots += 1;
    const prior = exactById.get(evidence.id);
    if (prior && (prior.setId !== evidence.setId || prior.finishes.join('|') !== evidence.finishes.join('|'))) {
      conflictingSnapshots += 1;
      exactById.set(evidence.id, null);
    } else if (!prior) exactById.set(evidence.id, evidence);
  }

  let rawUnknown = 0;
  let reconciled = 0;
  let noExactSnapshot = 0;
  let setMismatch = 0;
  const reconciledIds = [];
  const cards = census.cards.map(card => {
    if (card.digital || card.held || !card.englishNamed || (card.explicitFinishes || []).length) return card;
    rawUnknown += 1;
    const evidence = exactById.get(card.id);
    if (!evidence) { noExactSnapshot += 1; return card; }
    if (evidence.setId !== card.setId) { setMismatch += 1; return card; }
    reconciled += 1;
    reconciledIds.push(card.id);
    return { ...card, explicitFinishes: evidence.finishes, finishEvidenceOrigin: 'materialized_tcgdex_api_snapshot' };
  });

  return {
    census: { ...census, cards },
    report: {
      format: 'fatedrop-primary-finish-evidence-reconciliation-v1',
      sourceRevision: census.revision,
      productionWrites: false,
      snapshotNamespace: namespace,
      snapshotVersion: sourceVersion,
      snapshotsInspected,
      exactCardSnapshots,
      conflictingSnapshots,
      rawUnknown,
      reconciled,
      noExactSnapshot,
      setMismatch,
      reconciledIds,
      note: 'Pinned raw finish declarations remain authoritative; this report explicitly records where exact cached TCGdex API evidence resolves raw declaration gaps without guessing standard or substituting finishes.',
    },
  };
}
