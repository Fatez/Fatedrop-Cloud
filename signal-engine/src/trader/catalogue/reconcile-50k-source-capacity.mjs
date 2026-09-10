import { writeFile } from 'node:fs/promises';
import { createTcgdexClient } from './source-clients.mjs';
import { createPokemonTcgApiRegionalClient } from './pokemontcgapi-client.mjs';

const TARGET_IDENTITIES = 50_000;
const CURRENT_REHEARSED_IDENTITIES = 27_624;
const REGION_LANGUAGES = Object.freeze({ WEST: 'en', JP: 'ja', CN: 'zh-cn' });

function id(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveTotal(set) {
  const total = Number(set?.total ?? set?.printed_total ?? set?.printedTotal);
  return Number.isInteger(total) && total >= 0 ? total : 0;
}

async function tcgdexPhysicalSets(languageCode) {
  const client = createTcgdexClient({ languageCode });
  const [sets, pocket] = await Promise.all([
    client.listSets(),
    client.getSeries('tcgp').catch(() => null),
  ]);
  const pocketIds = new Set((pocket?.sets || []).map((set) => id(set?.id)).filter(Boolean));
  return sets.filter((set) => !pocketIds.has(id(set?.id)));
}

function exactSetCandidates(sourceSet) {
  return new Set([id(sourceSet?.id), id(sourceSet?.code), id(sourceSet?.legacy_id)].filter(Boolean));
}

async function regionCapacity(region, apiClient) {
  const languageCode = REGION_LANGUAGES[region];
  const [sourceSets, tcgdexSets] = await Promise.all([
    apiClient.listSets({ region }),
    tcgdexPhysicalSets(languageCode),
  ]);
  const tcgdexIds = new Set(tcgdexSets.map((set) => id(set?.id)).filter(Boolean));
  const exactOverlap = sourceSets.filter((set) => [...exactSetCandidates(set)].some((candidate) => tcgdexIds.has(candidate)));
  const unmatched = sourceSets.filter((set) => ![...exactSetCandidates(set)].some((candidate) => tcgdexIds.has(candidate)));

  return Object.freeze({
    region,
    languageCode,
    sourceSetCount: sourceSets.length,
    tcgdexPhysicalSetCount: tcgdexSets.length,
    declaredSourcePrintings: sourceSets.reduce((sum, set) => sum + positiveTotal(set), 0),
    exactSetIdOrLegacyOverlapCount: exactOverlap.length,
    exactOverlapDeclaredPrintings: exactOverlap.reduce((sum, set) => sum + positiveTotal(set), 0),
    unmatchedSourceSetCount: unmatched.length,
    unmatchedSourceSets: unmatched.map((set) => ({
      id: id(set?.id),
      code: id(set?.code),
      legacyId: id(set?.legacy_id),
      name: String(set?.name ?? ''),
      declaredTotal: positiveTotal(set),
    })),
  });
}

async function main() {
  const apiClient = createPokemonTcgApiRegionalClient({
    apiKey: process.env.PTCG_API_KEY,
    snapshotDirectory: process.env.CATALOGUE_SOURCE_SNAPSHOT_DIR || null,
    snapshotVersion: process.env.CATALOGUE_PTCGAPI_SNAPSHOT_VERSION || null,
  });

  const regions = [];
  for (const region of Object.keys(REGION_LANGUAGES)) regions.push(await regionCapacity(region, apiClient));
  const exactOverlapDeclaredPrintings = regions.reduce((sum, row) => sum + row.exactOverlapDeclaredPrintings, 0);
  const sourceDeclaredPrintings = regions.reduce((sum, row) => sum + row.declaredSourcePrintings, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'source_capacity_census',
    productionWrites: false,
    targetVerifiedIdentities: TARGET_IDENTITIES,
    currentRehearsedVerifiedIdentities: CURRENT_REHEARSED_IDENTITIES,
    identitiesStillNeeded: TARGET_IDENTITIES - CURRENT_REHEARSED_IDENTITIES,
    source: 'pokemontcgapi',
    corroboratingSource: 'tcgdex',
    policy: {
      exactSetIdsOrExplicitLegacyIdsOnly: true,
      fuzzyMatching: false,
      sourceMappingsAreNotCards: true,
      declaredPrintingCapacityIsNotYetVerifiedIdentityCount: true,
      productionActivation: false,
    },
    sourceDeclaredPrintings,
    exactOverlapDeclaredPrintings,
    regions,
  };

  const output = process.env.RUNNER_TEMP || '.';
  await writeFile(`${output}/catalogue-50k-source-capacity.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
