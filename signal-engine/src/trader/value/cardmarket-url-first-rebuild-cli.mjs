import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import {
  buildCardmarketProductIndexes,
  chooseDominantExpansion,
  probeReviewedUrl,
  resolveCardmarketProduct,
  reviewedCardmarketUrl,
  structuredExpansionVotes,
} from './cardmarket-url-first-rebuild.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-url-first-rebuild-source-2026-09-15.json');
const expectedVariantKey = (variantCode) => variantCode === 'holo' ? 'holo' : 'normal';
const targetPriceLane = (variantCode) => variantCode === 'holo' ? 'holo' : 'standard';

async function loadEvidence() {
  const evidence = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (evidence?.schemaVersion !== 1) throw new Error('Unsupported Cardmarket URL-first evidence schema');
  if (evidence?.policy?.productionWrites !== false) throw new Error('URL-first evidence must remain read-only');
  if (evidence?.sourceRows !== 1316 || evidence?.urlReconstructionValidatedRows !== 1316 || evidence?.urlReconstructionMismatches !== 0) {
    throw new Error('Reviewed Cardmarket URL source evidence drifted');
  }
  return evidence;
}

function groupBy(rows, keyFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = grouped.get(key) || [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return grouped;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function expansionFromSetSource(setId, setSourceRows, indexes) {
  const ids = [...new Set((setSourceRows.get(setId) || [])
    .map((row) => String(row.source_record_id || '').trim())
    .filter((id) => id && indexes.byExpansion.has(id)))];
  return ids.length === 1 ? ids[0] : null;
}

function inferExpansionForSet(setId, setIdentities, currentMappings, setSourceRows, indexes) {
  const setSource = expansionFromSetSource(setId, setSourceRows, indexes);
  if (setSource) return Object.freeze({ expansionId: setSource, method: 'cardmarket_set_source_mapping', anchors: 1, share: 1 });

  const existingVotes = new Map();
  for (const mapping of currentMappings) {
    if (mapping.set_id !== setId) continue;
    const product = indexes.byId.get(String(mapping.source_record_id));
    const expansion = String(product?.sourceExpansionId ?? '').trim();
    if (expansion) increment(existingVotes, expansion);
  }
  const existing = chooseDominantExpansion(existingVotes, { minimumAnchors: 3, minimumShare: 0.9 });
  if (existing) return Object.freeze({ ...existing, method: 'dominant_existing_cardmarket_mapping_expansion' });

  const structuredVotes = structuredExpansionVotes(setIdentities, indexes);
  const structured = chooseDominantExpansion(structuredVotes, { minimumAnchors: Math.min(2, setIdentities.length), minimumShare: 0.75 });
  if (structured) return Object.freeze({ ...structured, method: 'structured_cardmarket_name_collector_cluster' });

  return null;
}

function compareCurrent(identity, result, mappingsByIdentity) {
  const current = mappingsByIdentity.get(identity.id) || [];
  const expectedKey = expectedVariantKey(identity.variant_code);
  const target = current.filter((row) => row.source_variant_key === expectedKey);
  if (result.status !== 'resolved') {
    return Object.freeze({ state: target.length ? 'CURRENT_MAPPING_NOT_VERIFIED_BY_MODEL' : 'UNMAPPED_UNRESOLVED', current: target });
  }
  if (target.length === 0) return Object.freeze({ state: 'NEW_MAPPING_CANDIDATE', current: [] });
  if (target.some((row) => String(row.source_record_id) === String(result.sourceRecordId))) {
    return Object.freeze({ state: target.length === 1 ? 'MATCH' : 'MATCH_WITH_DUPLICATE_CURRENT_ROWS', current: target });
  }
  return Object.freeze({ state: 'MISMATCH', current: target });
}

function centralTargetPrice(result, variantCode) {
  if (result.status !== 'resolved') return false;
  return Boolean(result.priceEvidence?.[targetPriceLane(variantCode)]);
}

export async function build(db, { sources, evidence } = {}) {
  const reviewed = evidence || await loadEvidence();
  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const indexes = buildCardmarketProductIndexes(products);
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id,i.variant_code,p.id AS printing_id,p.set_id,s.name AS set_name,p.name,p.collector_number,
      COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') AS classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=p.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
    ORDER BY s.name,p.collector_number,p.name,i.variant_code,i.id`);

  const { rows: currentMappings } = await db.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,p.set_id
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE m.source_name='cardmarket'`);

  const { rows: setMappings } = await db.query(`
    SELECT set_id,source_record_id
    FROM fatedrop_card_set_source_mappings
    WHERE source_name='cardmarket'`);

  const mappingsByIdentity = groupBy(currentMappings, (row) => row.card_identity_id);
  const setSourceRows = groupBy(setMappings, (row) => row.set_id);
  const identitiesBySet = groupBy(identities, (row) => row.set_id);
  const expansionBySet = new Map();
  const unresolvedSets = [];
  for (const [setId, setIdentities] of identitiesBySet.entries()) {
    const inferred = inferExpansionForSet(setId, setIdentities, currentMappings, setSourceRows, indexes);
    if (inferred) expansionBySet.set(setId, inferred);
    else unresolvedSets.push(Object.freeze({ setId, setName: setIdentities[0]?.set_name || null, identities: setIdentities.length }));
  }

  const rows = [];
  const counts = {
    eligible: identities.length,
    currentMappedIdentities: 0,
    currentUnmappedIdentities: 0,
    modelResolved: 0,
    modelAmbiguous: 0,
    modelUnresolved: 0,
    matches: 0,
    mismatches: 0,
    newMappingCandidates: 0,
    currentMappingsNotVerified: 0,
    currentUnmappedResolved: 0,
    currentUnmappedAmbiguous: 0,
    currentUnmappedUnresolved: 0,
    targetLanePriceable: 0,
    currentUnmappedTargetLanePriceable: 0,
    holoBaseLaneOnly: 0,
    forensicResidual: 0,
  };

  for (const identity of identities) {
    const current = mappingsByIdentity.get(identity.id) || [];
    const isMapped = current.length > 0;
    if (isMapped) counts.currentMappedIdentities += 1;
    else counts.currentUnmappedIdentities += 1;
    const inferred = expansionBySet.get(identity.set_id);
    const url = reviewedCardmarketUrl({
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
    }, reviewed.setSlugOverrides);

    const result = inferred
      ? resolveCardmarketProduct(identity, inferred.expansionId, indexes, priceById)
      : Object.freeze({ status: 'unresolved', reason: 'CARDMARKET_EXPANSION_UNRESOLVED', candidates: [] });
    if (result.status === 'resolved') counts.modelResolved += 1;
    else if (result.status === 'ambiguous') counts.modelAmbiguous += 1;
    else counts.modelUnresolved += 1;

    const comparison = compareCurrent(identity, result, mappingsByIdentity);
    if (comparison.state === 'MATCH' || comparison.state === 'MATCH_WITH_DUPLICATE_CURRENT_ROWS') counts.matches += 1;
    else if (comparison.state === 'MISMATCH') counts.mismatches += 1;
    else if (comparison.state === 'NEW_MAPPING_CANDIDATE') counts.newMappingCandidates += 1;
    else if (comparison.state === 'CURRENT_MAPPING_NOT_VERIFIED_BY_MODEL') counts.currentMappingsNotVerified += 1;

    const priceable = centralTargetPrice(result, identity.variant_code);
    if (priceable) counts.targetLanePriceable += 1;
    if (identity.variant_code === 'holo' && result.status === 'resolved' && !result.priceEvidence.holo && result.priceEvidence.standard) counts.holoBaseLaneOnly += 1;

    if (!isMapped) {
      if (result.status === 'resolved') counts.currentUnmappedResolved += 1;
      else if (result.status === 'ambiguous') counts.currentUnmappedAmbiguous += 1;
      else counts.currentUnmappedUnresolved += 1;
      if (priceable) counts.currentUnmappedTargetLanePriceable += 1;
    }

    rows.push(Object.freeze({
      cardIdentityId: identity.id,
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      classifierState: identity.classifier_state,
      reviewedCardmarketUrl: url,
      expansion: inferred || null,
      model: result,
      comparison,
    }));
  }

  const currentUnmapped = rows.filter((row) => row.comparison.state === 'NEW_MAPPING_CANDIDATE' || row.comparison.state === 'UNMAPPED_UNRESOLVED');
  const mismatchRows = rows.filter((row) => row.comparison.state === 'MISMATCH');
  const currentUnverifiedRows = rows.filter((row) => row.comparison.state === 'CURRENT_MAPPING_NOT_VERIFIED_BY_MODEL');
  const newRows = rows.filter((row) => row.comparison.state === 'NEW_MAPPING_CANDIDATE');
  const forensicResidual = rows.filter((row) => !(
    row.model.status === 'resolved'
    && row.model.method === 'structured_name_collector'
  ));
  counts.forensicResidual = forensicResidual.length;

  const probeTargets = currentUnmapped.slice(0, 3);
  const urlProbes = [];
  for (const row of probeTargets) {
    urlProbes.push(Object.freeze({
      cardIdentityId: row.cardIdentityId,
      url: row.reviewedCardmarketUrl,
      probe: await probeReviewedUrl(row.reviewedCardmarketUrl),
    }));
  }

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      workbook: reviewed.sourceFile,
      workbookSha256: reviewed.sourceFileSha256,
      workbookRows: reviewed.sourceRows,
      workbookUrlReconstructionValidatedRows: reviewed.urlReconstructionValidatedRows,
      currentQueueExpectedUnmappedRows: reviewed.currentUnmappedRows,
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      priceGuideSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze(counts),
    sourceCoverage: Object.freeze({
      currentUnmappedExpected: reviewed.currentUnmappedRows,
      currentUnmappedObserved: counts.currentUnmappedIdentities,
      exactHistoricalUrlCoverageWasValidated: reviewed.currentUnmappedRowsCoveredBySource === reviewed.currentUnmappedRows,
      historicalUrlMismatchCount: reviewed.currentUnmappedUrlMismatches,
    }),
    expansionResolution: Object.freeze({
      resolvedSets: expansionBySet.size,
      unresolvedSets: unresolvedSets.length,
      unresolvedSetDetails: Object.freeze(unresolvedSets),
    }),
    urlProbes: Object.freeze(urlProbes),
    forensicResidual: Object.freeze(forensicResidual),
    newMappingCandidates: Object.freeze(newRows),
    mismatches: Object.freeze(mismatchRows),
    currentMappingsNotVerified: Object.freeze(currentUnverifiedRows),
    currentUnmappedResidual: Object.freeze(currentUnmapped.filter((row) => row.model.status !== 'resolved')),
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-url-first-rebuild.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    productionWrites: report.productionWrites,
    error: report.error,
    counts: report.counts,
    sourceCoverage: report.sourceCoverage,
    expansionResolution: report.expansionResolution && {
      resolvedSets: report.expansionResolution.resolvedSets,
      unresolvedSets: report.expansionResolution.unresolvedSets,
    },
    urlProbes: report.urlProbes,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();