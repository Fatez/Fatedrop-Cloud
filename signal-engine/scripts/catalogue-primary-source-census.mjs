// Run with Bun: imports the provider's TypeScript data, without using network APIs or a database.
import { readdir, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(option('repo') || '_evidence/tcgdex');
const output = resolve(option('out') || 'catalogue-primary-source-census.json');
const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expected = option('revision');
if (!expected || revision !== expected) throw new Error('An exact matching --revision is required');
const english = value => typeof value === 'string' ? value.trim() : typeof value?.en === 'string' ? value.en.trim() : '';
const readModule = async path => (await import(pathToFileURL(path).href)).default;
const files = async path => (await readdir(path, { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.ts')).sort((a,b) => a.name.localeCompare(b.name));
const setIds = new Set();
const cards = new Map();
const sets = [];
const exclusions = [];
const holds = new Set(['base2','base3','base5','gym1','neo1','neo2','neo3','neo4']);
let allCardFiles = 0;
for (const eraFile of await files(join(root, 'data'))) {
  const era = await readModule(join(root, 'data', eraFile.name));
  const eraDir = join(root, 'data', basename(eraFile.name, '.ts'));
  let setFiles;
  try { setFiles = await files(eraDir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const setFile of setFiles) {
    const set = await readModule(join(eraDir, setFile.name));
    const setId = String(set.id || '').trim();
    if (!setId || setIds.has(setId)) throw new Error(`Missing/duplicate source set ID: ${setId}`);
    setIds.add(setId);
    const row = { eraId: era.id, eraName: english(era.name) || null, setId, setName: english(set.name) || null, sourceCardFiles: 0, englishNamedCardRecords: 0, explicitFinishCandidates: 0, unknownFinishRecords: 0, firstEditionRecords: 0, intentionalSetHold: holds.has(setId), digital: String(era.id).toLowerCase() === 'tcgp' || /pocket/i.test(english(era.name)) };
    let cardFiles;
    try { cardFiles = await files(join(eraDir, basename(setFile.name, '.ts'))); } catch (error) { if (error.code === 'ENOENT') cardFiles = []; else throw error; }
    for (const cardFile of cardFiles) {
      allCardFiles++; row.sourceCardFiles++;
      const localId = basename(cardFile.name, '.ts');
      const id = `${setId}-${localId}`;
      if (cards.has(id)) throw new Error(`Duplicate source card ID: ${id}`);
      const card = await readModule(join(eraDir, basename(setFile.name, '.ts'), cardFile.name));
      const eligible = Boolean(row.eraName && row.setName && english(card.name));
      const variants = card.variants;
      const finishes = Array.isArray(variants)
        ? [...new Set(variants.map(v => v.type).filter(v => ['normal','holo','reverse'].includes(v)))]
        : ['normal','holo','reverse'].filter(v => variants?.[v] === true);
      const firstEdition = Array.isArray(variants) ? variants.some(v => v.stamp?.includes('1st-edition')) : variants?.firstEdition === true;
      const entry = { id, setId, localId, language: 'en', englishNamed: eligible, explicitFinishes: finishes, firstEdition, held: holds.has(setId) || firstEdition, digital: row.digital };
      cards.set(id, entry);
      if (!eligible) { exclusions.push({ id, reason: 'no_explicit_english_name_in_hierarchy' }); continue; }
      row.englishNamedCardRecords++;
      if (!finishes.length) row.unknownFinishRecords++;
      if (firstEdition) row.firstEditionRecords++;
      if (!entry.held && !entry.digital) row.explicitFinishCandidates += finishes.length;
    }
    sets.push(row);
  }
}
const report = {
  format: 'fatedrop-primary-source-census-v1', source: 'tcgdex/cards-database', revision,
  generatedAt: new Date().toISOString(), productionWrites: false,
  scope: 'Full pinned source tree; explicit English names are counted separately; digital sets excluded from physical finish candidates',
  counts: { sourceSets: sets.length, sourceCardFiles: allCardFiles, uniqueSourceCardIds: cards.size,
    englishNamedCardRecords: sets.reduce((n,s) => n+s.englishNamedCardRecords,0),
    physicalEnglishNamedCardRecords: sets.filter(s=>!s.digital).reduce((n,s)=>n+s.englishNamedCardRecords,0),
    explicitFinishCandidatesOutsideHolds: sets.reduce((n,s)=>n+s.explicitFinishCandidates,0),
    unknownFinishRecords: sets.reduce((n,s)=>n+s.unknownFinishRecords,0),
    firstEditionRecords: sets.reduce((n,s)=>n+s.firstEditionRecords,0) },
  verifiedProductionIdentities: null, completeCanonicalIdentityCardinality: null,
  limitations: ['Source records are not verified canonical identities.', 'English names do not independently prove language release availability.', 'Missing variants are not defaulted to standard.', 'Stamp/edition composition needs separate verification; no production IDs are created.', '74,000 remains an unverified target, not a source denominator.'],
  sets, cards: [...cards.values()], exclusions,
};
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, revision, counts: report.counts, completeCanonicalIdentityCardinality: null, productionWrites: false }, null, 2));
