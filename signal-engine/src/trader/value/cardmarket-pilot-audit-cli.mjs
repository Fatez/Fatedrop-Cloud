import { PostgresStore } from '../../stores/postgres-store.mjs';
import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { cataloguePilotDefinition } from '../catalogue/pilots.mjs';
import { listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { auditApprovedCardmarketExpansion, rankCardmarketExpansionEvidence } from './cardmarket-mapping-audit.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function positiveInt(value, field) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${field} must be a positive integer`);
  return parsed;
}

function exactSet(sets, selector) {
  const clean = String(selector || '').trim();
  if (!clean) return null;
  const matches = sets.filter((set) => set.id === clean || set.name === clean);
  if (matches.length !== 1) throw new Error(`Expected one exact verified set for ${clean}; found ${matches.length}`);
  return matches[0];
}

function pilotSets(sets, pilotKey) {
  const pilot = cataloguePilotDefinition(pilotKey);
  return pilot.setNames.map((setName) => {
    const matches = sets.filter((set) => set.name === setName);
    if (matches.length !== 1) throw new Error(`Pilot set ${setName} is not uniquely present in the verified catalogue; found ${matches.length}`);
    return matches[0];
  });
}

async function auditSet({ store, products, set, expansion }) {
  const cards = await listVerifiedCardsFromStore(store, { setId: set.id, languageCode: 'en', limit: 500 });
  const completeness = assessCanonicalSetCompleteness({ set, canonicalCards: cards, requiredLanguageCode:'en' });
  const base = {
    setId: set.id,
    setName: set.name,
    collectorReady: completeness.status === 'complete',
    completeness,
    verifiedEnglishCards: cards.length,
  };
  if (completeness.status !== 'complete') {
    return Object.freeze({ ...base, mappingAudit: null, expansionEvidence: Object.freeze([]) });
  }
  if (expansion) {
    return Object.freeze({
      ...base,
      approvedExpansionIdSupplied: expansion,
      expansionEvidence: Object.freeze([]),
      mappingAudit: auditApprovedCardmarketExpansion(products, cards, expansion),
    });
  }
  return Object.freeze({
    ...base,
    approvedExpansionIdSupplied: null,
    expansionEvidence: rankCardmarketExpansionEvidence(products, cards, { limit: 8 }),
    mappingAudit: null,
  });
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pilotKey = String(argValue('pilot') || 'collector-v1').trim();
  const setSelector = String(argValue('set') || '').trim();
  const expansion = positiveInt(argValue('expansion'), '--expansion');
  if (expansion && !setSelector) throw new Error('--expansion requires --set so expansion scope is explicit');

  const store = new PostgresStore(databaseUrl);
  const verifiedSets = await listVerifiedCardSetsFromStore(store, { tcgCode: 'pokemon', limit: 1000 });
  const selectedSets = setSelector ? [exactSet(verifiedSets, setSelector)] : pilotSets(verifiedSets, pilotKey);
  const source = await fetchCardmarketPokemonSinglesCatalogue();
  const setReports = [];
  for (const set of selectedSets) {
    setReports.push(await auditSet({ store, products: source.products, set, expansion }));
  }

  console.log(JSON.stringify({
    mode: 'read-only-audit',
    writesPerformed: false,
    generatedAt: new Date().toISOString(),
    pilotKey: setSelector ? null : pilotKey,
    source: {
      url: source.artifact.url,
      fetchedAt: source.artifact.fetchedAt,
      lastModified: source.artifact.lastModified,
      sha256: source.artifact.sha256,
      byteLength: source.artifact.byteLength,
      productCount: source.products.length,
    },
    sets: setReports,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, writesPerformed: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
