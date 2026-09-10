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
  const total = Number(set?.total ?? set?.printed_total ?? set?.printedTotal ?? set?.card_count ?? set?.cardCount?.total);
  return Number.isInteger(total) && total >= 0 ? total : 0;
}

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ');
}

function epochDay(value) {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

function sourceReleaseDay(set) {
  return epochDay(set?.release_date ?? set?.releaseDate ?? set?.released_at ?? set?.releasedAt);
}

function tcgdexReleaseDay(set) {
  return epochDay(set?.releaseDate ?? set?.release_date ?? set?.releasedAt);
}

async function tcgdexPhysicalSets(languageCode) {
  const client = createTcgdexClient({ languageCode });
  const [briefs, pocket] = await Promise.all([
    client.listSets(),
    client.getSeries('tcgp').catch(() => null),
  ]);
  const pocketIds = new Set((pocket?.sets || []).map((set) => id(set?.id)).filter(Boolean));
  const physicalBriefs = briefs.filter((set) => !pocketIds.has(id(set?.id)));

  // Set listings are intentionally treated as navigation evidence only. Fetch
  // the full set records before using totals/dates as exact reconciliation anchors.
  const full = [];
  for (const brief of physicalBriefs) full.push(await client.getSet(id(brief.id)));
  return full;
}

function exactSetCandidates(sourceSet) {
  return new Set([id(sourceSet?.id), id(sourceSet?.code), id(sourceSet?.legacy_id)].filter(Boolean));
}

function evidenceKey(set, releaseDayFn) {
  const name = normalizeName(set?.name);
  const total = positiveTotal(set);
  const day = releaseDayFn(set);
  if (!name || !total || day == null) return null;
  return `${name}|${total}|${day}`;
}

function indexUnique(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

async function regionCapacity(region, apiClient) {
  const languageCode = REGION_LANGUAGES[region];
  const [sourceSets, tcgdexSets] = await Promise.all([
    apiClient.listSets({ region }),
    tcgdexPhysicalSets(languageCode),
  ]);
  const tcgdexIds = new Set(tcgdexSets.map((set) => id(set?.id)).filter(Boolean));
  const tcgdexEvidence = indexUnique(tcgdexSets, (set) => evidenceKey(set, tcgdexReleaseDay));

  const exactIdOverlap = [];
  const exactEvidenceOverlap = [];
  const unmatched = [];
  const claimedTcgdexIds = new Set();

  for (const sourceSet of sourceSets) {
    const matchingId = [...exactSetCandidates(sourceSet)].find((candidate) => tcgdexIds.has(candidate));
    if (matchingId) {
      exactIdOverlap.push(sourceSet);
      claimedTcgdexIds.add(matchingId);
      continue;
    }

    const key = evidenceKey(sourceSet, sourceReleaseDay);
    const candidates = key ? (tcgdexEvidence.get(key) || []) : [];
    const available = candidates.filter((candidate) => !claimedTcgdexIds.has(id(candidate?.id)));
    if (available.length === 1) {
      exactEvidenceOverlap.push(sourceSet);
      claimedTcgdexIds.add(id(available[0]?.id));
      continue;
    }
    unmatched.push(sourceSet);
  }

  const exactOverlap = [...exactIdOverlap, ...exactEvidenceOverlap];
  return Object.freeze({
    region,
    languageCode,
    sourceSetCount: sourceSets.length,
    tcgdexPhysicalSetCount: tcgdexSets.length,
    declaredSourcePrintings: sourceSets.reduce((sum, set) => sum + positiveTotal(set), 0),
    exactSetIdOrLegacyOverlapCount: exactIdOverlap.length,
    exactNameTotalReleaseDateOverlapCount: exactEvidenceOverlap.length,
    exactSetEvidenceOverlapCount: exactOverlap.length,
    exactOverlapDeclaredPrintings: exactOverlap.reduce((sum, set) => sum + positiveTotal(set), 0),
    unmatchedSourceSetCount: unmatched.length,
    unmatchedSourceSets: unmatched.map((set) => ({
      id: id(set?.id),
      code: id(set?.code),
      legacyId: id(set?.legacy_id),
      name: String(set?.name ?? ''),
      declaredTotal: positiveTotal(set),
      releaseDate: set?.release_date ?? set?.releaseDate ?? set?.released_at ?? set?.releasedAt ?? null,
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
      exactSetIdsOrExplicitLegacyIdsOnly: false,
      exactUniqueNameTotalReleaseDateAllowed: true,
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
