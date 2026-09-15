import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import {
  buildCardmarketProductIndexes,
  chooseDominantExpansion,
  resolveCardmarketProduct,
  reviewedCardmarketUrl,
  structuredExpansionVotes,
} from './cardmarket-url-first-rebuild.mjs';

const STRICT_REPORT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-strict.json');
const EVIDENCE_PATH = path.resolve('evidence/cardmarket-url-first-rebuild-source-2026-09-15.json');
const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification.json');

// Cardmarket's public price guide does not expose a separate first-edition /
// shadowless price lane. These sets are therefore deliberately excluded from
// price activation until the edition-aware market lane is certified.
const EDITIONED_SET_CODES = new Set([
  'base1', 'base2', 'base3', 'base4', 'base5',
  'gym1', 'gym2', 'neo1', 'neo2', 'neo3', 'neo4',
]);

const supportedVariant = (variantCode) => ['standard', 'holo', 'reverse-holo'].includes(variantCode);
const priceLaneVariant = (variantCode) => variantCode === 'standard' || variantCode === 'holo';
const sourceVariantKey = (variantCode) => variantCode === 'holo' ? 'holo' : 'normal';
const targetPriceLane = (variantCode) => variantCode === 'holo' ? 'holo' : 'standard';
const sourceKey = (sourceRecordId, variantKey) => `${sourceRecordId}|${variantKey}`;

function sha256(lines) {
  const hash = createHash('sha256');
  for (const line of lines) hash.update(`${line}\n`);
  return hash.digest('hex');
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
  const structured = chooseDominantExpansion(structuredVotes, {
    minimumAnchors: Math.min(2, setIdentities.length),
    minimumShare: 0.75,
  });
  if (structured) return Object.freeze({ ...structured, method: 'structured_cardmarket_name_collector_cluster' });
  return null;
}

function mappingDigest(rows) {
  return sha256(rows
    .map((row) => [
      row.id,
      row.card_identity_id,
      row.source_record_id,
      row.source_variant_key,
      row.source_url || '',
      row.source_version || '',
    ].join('|'))
    .sort());
}

function buildStrictIndexes(strict) {
  const resolved = new Map();
  const held = new Map();
  for (const row of [...(strict.safeMappings || []), ...(strict.conflicts || [])]) {
    const prior = resolved.get(row.cardIdentityId);
    if (prior && (String(prior.sourceRecordId) !== String(row.sourceRecordId) || prior.sourceVariantKey !== row.sourceVariantKey)) {
      held.set(row.cardIdentityId, { reason: 'FORENSIC_RESULT_COLLISION' });
      resolved.delete(row.cardIdentityId);
      continue;
    }
    resolved.set(row.cardIdentityId, row);
  }
  for (const row of strict.rejectedNameMismatch || []) held.set(row.cardIdentityId, row);
  for (const row of strict.held || []) held.set(row.card_identity_id || row.cardIdentityId, row);
  return { resolved, held };
}

function identitySummary(identity) {
  return {
    cardIdentityId: identity.id,
    setCode: identity.set_code,
    setName: identity.set_name,
    name: identity.name,
    collectorNumber: identity.collector_number,
    variantCode: identity.variant_code,
    classifierState: identity.classifier_state,
  };
}

function quarantineRow(identity, reason, details = null) {
  return Object.freeze({ ...identitySummary(identity), reason, details });
}

function candidateFromModel(identity, model, url, expansion) {
  return Object.freeze({
    ...identitySummary(identity),
    sourceRecordId: String(model.sourceRecordId),
    sourceVariantKey: sourceVariantKey(identity.variant_code),
    reviewedCardmarketUrl: url,
    forensicEvidenceUrl: null,
    cardmarketProductName: model.productName || null,
    cardmarketExpansionId: String(model.expansionId || expansion?.expansionId || ''),
    method: `simple:${model.method}`,
    priceEvidence: Object.freeze({
      standard: Boolean(model.priceEvidence?.standard),
      holo: Boolean(model.priceEvidence?.holo),
      targetLane: Boolean(model.priceEvidence?.[targetPriceLane(identity.variant_code)]),
    }),
  });
}

function candidateFromStrict(identity, strictRow, url) {
  return Object.freeze({
    ...identitySummary(identity),
    sourceRecordId: String(strictRow.sourceRecordId),
    sourceVariantKey: sourceVariantKey(identity.variant_code),
    reviewedCardmarketUrl: strictRow.reviewedCardmarketUrl || url,
    forensicEvidenceUrl: strictRow.tcggo?.url || strictRow.evidenceUrl || null,
    cardmarketProductName: strictRow.cardmarketProductName || null,
    cardmarketExpansionId: String(strictRow.cardmarketExpansionId || ''),
    method: 'forensic:exact_tcgdex_id_to_cardmarket',
    priceEvidence: Object.freeze({
      standard: Boolean(strictRow.priceEvidence?.standard),
      holo: Boolean(strictRow.priceEvidence?.holo),
      targetLane: Boolean(strictRow.priceEvidence?.targetLane),
    }),
  });
}

function candidateDigest(rows) {
  return sha256(rows.map((row) => [
    row.cardIdentityId,
    row.sourceRecordId,
    row.sourceVariantKey,
    row.reviewedCardmarketUrl,
    row.action,
  ].join('|')).sort());
}

export async function build(db, { strictReport, evidence, sources } = {}) {
  const [strictRaw, evidenceRaw] = await Promise.all([
    strictReport ? null : readFile(STRICT_REPORT(), 'utf8'),
    evidence ? null : readFile(EVIDENCE_PATH, 'utf8'),
  ]);
  const strict = strictReport || JSON.parse(strictRaw);
  const reviewed = evidence || JSON.parse(evidenceRaw);
  if (strict?.status !== 'audit_complete' || strict?.productionWrites !== false) throw new Error('Completed read-only strict bridge report required');
  if (reviewed?.policy?.productionWrites !== false) throw new Error('Read-only URL evidence required');

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const indexes = buildCardmarketProductIndexes(products);
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id,i.variant_code,i.verification_status,p.id AS printing_id,p.set_id,
      s.code AS set_code,s.name AS set_name,p.name,p.collector_number,
      COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') AS classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=p.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified' AND i.language_code='en'
    ORDER BY s.name,p.collector_number,p.name,i.variant_code,i.id`);

  const { rows: currentMappings } = await db.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,m.source_url,m.source_version,p.set_id
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE m.source_name='cardmarket'
    ORDER BY m.id`);

  const { rows: setMappings } = await db.query(`
    SELECT set_id,source_record_id
    FROM fatedrop_card_set_source_mappings
    WHERE source_name='cardmarket'`);

  const mappingsByIdentity = groupBy(currentMappings, (row) => row.card_identity_id);
  const ownersBySourceKey = groupBy(currentMappings, (row) => sourceKey(row.source_record_id, row.source_variant_key));
  const setSourceRows = groupBy(setMappings, (row) => row.set_id);
  const strictIndexes = buildStrictIndexes(strict);

  const marketIdentities = identities.filter((identity) =>
    supportedVariant(identity.variant_code)
    && !EDITIONED_SET_CODES.has(String(identity.set_code).toLowerCase())
    && !['INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE'].includes(identity.classifier_state));
  const identitiesBySet = groupBy(marketIdentities, (row) => row.set_id);
  const expansionBySet = new Map();
  for (const [setId, setIdentities] of identitiesBySet.entries()) {
    const inferred = inferExpansionForSet(setId, setIdentities, currentMappings, setSourceRows, indexes);
    if (inferred) expansionBySet.set(setId, inferred);
  }

  const quarantine = new Map();
  const candidates = new Map();

  for (const identity of identities) {
    if (EDITIONED_SET_CODES.has(String(identity.set_code).toLowerCase())) {
      quarantine.set(identity.id, quarantineRow(identity, 'WOTC_EDITION_PRICE_LANE_DEFERRED'));
      continue;
    }
    if (!supportedVariant(identity.variant_code)) {
      quarantine.set(identity.id, quarantineRow(identity, 'CARDMARKET_VARIANT_UNSUPPORTED'));
      continue;
    }
    if (['INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE'].includes(identity.classifier_state)) {
      quarantine.set(identity.id, quarantineRow(identity, `CATALOGUE_${identity.classifier_state}`));
      continue;
    }

    const expansion = expansionBySet.get(identity.set_id) || null;
    const url = reviewedCardmarketUrl({
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
    }, reviewed.setSlugOverrides);
    const model = expansion
      ? resolveCardmarketProduct(identity, expansion.expansionId, indexes, priceById)
      : { status: 'unresolved', reason: 'CARDMARKET_EXPANSION_UNRESOLVED' };

    // Cardmarket's downloadable catalogue proves the exact product, but its
    // public price guide exposes only base/standard and holo numeric lanes.
    // Reverse-holo is therefore fully checked at product level and explicitly
    // quarantined from price activation rather than guessed from another lane.
    if (identity.variant_code === 'reverse-holo') {
      const currentReverseRows = (mappingsByIdentity.get(identity.id) || [])
        .filter((row) => row.source_variant_key === 'reverse');
      const exactProduct = model.status === 'resolved' && model.method === 'structured_name_collector';
      quarantine.set(identity.id, quarantineRow(identity,
        exactProduct ? 'CARDMARKET_REVERSE_PRICE_LANE_UNAVAILABLE' : `CARDMARKET_REVERSE_${model.reason || 'PRODUCT_UNRESOLVED'}`,
        {
          reviewedCardmarketUrl: url,
          expansionId: expansion?.expansionId || null,
          deterministicProductId: exactProduct ? String(model.sourceRecordId) : null,
          cardmarketProductName: exactProduct ? model.productName : null,
          currentReverseMappingRows: currentReverseRows.length,
          currentReverseMappingMatchesProduct: exactProduct
            ? currentReverseRows.some((row) => String(row.source_record_id) === String(model.sourceRecordId))
            : false,
          priceGuideReverseLaneAvailable: false,
        }));
      continue;
    }

    if (!priceLaneVariant(identity.variant_code)) {
      quarantine.set(identity.id, quarantineRow(identity, 'CARDMARKET_PRICE_LANE_UNSUPPORTED'));
      continue;
    }

    const strictRow = strictIndexes.resolved.get(identity.id) || null;

    // The simple lane is only accepted when Cardmarket itself gives us exact
    // structured name + collector-number identity inside the resolved expansion.
    // Root-name-only matches are intentionally sent to the forensic lane.
    const simple = model.status === 'resolved' && model.method === 'structured_name_collector'
      ? candidateFromModel(identity, model, url, expansion)
      : null;
    const forensic = strictRow ? candidateFromStrict(identity, strictRow, url) : null;

    if (simple && forensic && (
      simple.sourceRecordId !== forensic.sourceRecordId
      || simple.sourceVariantKey !== forensic.sourceVariantKey
    )) {
      quarantine.set(identity.id, quarantineRow(identity, 'SIMPLE_FORENSIC_PRODUCT_DISAGREEMENT', {
        simpleSourceRecordId: simple.sourceRecordId,
        forensicSourceRecordId: forensic.sourceRecordId,
      }));
      continue;
    }

    const candidate = simple || forensic;
    if (!candidate) {
      const forensicHeld = strictIndexes.held.get(identity.id);
      quarantine.set(identity.id, quarantineRow(identity, forensicHeld?.reason || model.reason || 'NO_DETERMINISTIC_CARDMARKET_MATCH', {
        expansion: expansion?.expansionId || null,
        modelStatus: model.status,
        modelMethod: model.method || null,
      }));
      continue;
    }
    candidates.set(identity.id, candidate);
  }

  // One Cardmarket source key may have exactly one FateDrop owner. Any desired
  // collision is quarantined before we consider repairing historical ownership.
  const desiredKeyRows = groupBy([...candidates.values()], (row) => sourceKey(row.sourceRecordId, row.sourceVariantKey));
  for (const [key, rows] of desiredKeyRows.entries()) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      candidates.delete(row.cardIdentityId);
      quarantine.set(row.cardIdentityId, quarantineRow(
        identities.find((identity) => identity.id === row.cardIdentityId),
        'DESIRED_SOURCE_KEY_COLLISION',
        { sourceKey: key, competingIdentityIds: rows.map((candidate) => candidate.cardIdentityId) },
      ));
    }
  }

  // Existing foreign ownership can be repaired only if the foreign owner is
  // itself deterministically certified to move to a different source key. This
  // loop is deliberately cascading: if one move becomes unsafe, anything that
  // relied on that owner vacating its old key is also quarantined.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [identityId, candidate] of [...candidates.entries()]) {
      const key = sourceKey(candidate.sourceRecordId, candidate.sourceVariantKey);
      const foreignOwners = (ownersBySourceKey.get(key) || [])
        .map((row) => row.card_identity_id)
        .filter((ownerId) => ownerId !== identityId);
      const unsafeOwners = foreignOwners.filter((ownerId) => {
        const ownerCandidate = candidates.get(ownerId);
        if (!ownerCandidate) return true;
        return sourceKey(ownerCandidate.sourceRecordId, ownerCandidate.sourceVariantKey) === key;
      });
      if (unsafeOwners.length === 0) continue;
      const identity = identities.find((row) => row.id === identityId);
      candidates.delete(identityId);
      quarantine.set(identityId, quarantineRow(identity, 'SOURCE_KEY_FOREIGN_OWNER_NOT_SAFELY_MOVING', {
        sourceKey: key,
        foreignOwnerIdentityIds: unsafeOwners,
      }));
      changed = true;
    }
  }

  const certified = [];
  for (const identity of identities) {
    const candidate = candidates.get(identity.id);
    if (!candidate) continue;
    const currentRows = mappingsByIdentity.get(identity.id) || [];
    const exactRows = currentRows.filter((row) =>
      String(row.source_record_id) === candidate.sourceRecordId
      && row.source_variant_key === candidate.sourceVariantKey);
    const action = currentRows.length === 1 && exactRows.length === 1
      ? 'retain'
      : currentRows.length === 0 ? 'insert' : 'replace';
    certified.push(Object.freeze({
      ...candidate,
      action,
      currentMappings: currentRows.map((row) => ({
        id: row.id,
        sourceRecordId: String(row.source_record_id),
        sourceVariantKey: row.source_variant_key,
        sourceUrl: row.source_url || null,
      })),
    }));
  }

  const quarantined = identities
    .filter((identity) => quarantine.has(identity.id))
    .map((identity) => quarantine.get(identity.id));

  if (certified.length + quarantined.length !== identities.length) {
    throw new Error(`Reconciliation gap: ${identities.length} verified English identities != ${certified.length} certified + ${quarantined.length} quarantined`);
  }

  const counts = {
    verifiedEnglish: identities.length,
    marketEligible: marketIdentities.length,
    certified: certified.length,
    retained: certified.filter((row) => row.action === 'retain').length,
    inserts: certified.filter((row) => row.action === 'insert').length,
    replacements: certified.filter((row) => row.action === 'replace').length,
    quarantined: quarantined.length,
    wotcEditionDeferred: quarantined.filter((row) => row.reason === 'WOTC_EDITION_PRICE_LANE_DEFERRED').length,
    reverseProductResolvedNoPriceLane: quarantined.filter((row) => row.reason === 'CARDMARKET_REVERSE_PRICE_LANE_UNAVAILABLE').length,
    reverseProductUnresolved: quarantined.filter((row) => row.reason.startsWith('CARDMARKET_REVERSE_') && row.reason !== 'CARDMARKET_REVERSE_PRICE_LANE_UNAVAILABLE').length,
    unsupportedVariant: quarantined.filter((row) => ['CARDMARKET_VARIANT_UNSUPPORTED', 'CARDMARKET_PRICE_LANE_UNSUPPORTED'].includes(row.reason)).length,
    classifierHeld: quarantined.filter((row) => row.reason.startsWith('CATALOGUE_')).length,
    deterministicFailureHeld: quarantined.filter((row) => ![
      'WOTC_EDITION_PRICE_LANE_DEFERRED',
      'CARDMARKET_REVERSE_PRICE_LANE_UNAVAILABLE',
      'CARDMARKET_VARIANT_UNSUPPORTED',
      'CARDMARKET_PRICE_LANE_UNSUPPORTED',
    ].includes(row.reason) && !row.reason.startsWith('CATALOGUE_') && !row.reason.startsWith('CARDMARKET_REVERSE_')).length,
    targetLanePriceable: certified.filter((row) => row.priceEvidence?.targetLane).length,
    exactMappedButNoTargetPriceLane: certified.filter((row) => !row.priceEvidence?.targetLane).length,
  };

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    programme: 'cardmarket_full_market_recertification_v1',
    policy: Object.freeze({
      language: 'en',
      deterministicSimpleMethod: 'resolved Cardmarket expansion + exact structured card name + collector number + explicit normal/holo price lane',
      reverseHoloMethod: 'exact product is audited but price activation is quarantined because Cardmarket public downloads expose no reverse price lane or fresh reverse-finish proof',
      forensicFallback: 'exact TCGdex identity -> public TCGGO Cardmarket product -> official Cardmarket catalogue',
      preserveCorrectMappings: true,
      replaceStaleIdentityMappingsAsOneUnit: true,
      sourceKeySingleOwner: true,
      noGuessing: true,
      noZeroPriceFallback: true,
      wotcEditionPriceLane: 'deferred',
    }),
    source: Object.freeze({
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      cardmarketPriceGuideSnapshotId: snapshot.sourceSnapshotId,
      reviewedUrlEvidenceSha256: reviewed.sourceFileSha256,
    }),
    precondition: Object.freeze({
      currentCardmarketMappingRows: currentMappings.length,
      currentCardmarketMappingDigest: mappingDigest(currentMappings),
    }),
    counts: Object.freeze(counts),
    reconciliation: Object.freeze({
      expectedVerifiedEnglish: identities.length,
      certified: certified.length,
      quarantined: quarantined.length,
      explained: certified.length + quarantined.length,
      unexplained: identities.length - certified.length - quarantined.length,
    }),
    certifiedDigest: candidateDigest(certified),
    certified: Object.freeze(certified),
    quarantine: Object.freeze(quarantined),
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
  await writeFile(OUTPUT(), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    error: report.error,
    counts: report.counts,
    reconciliation: report.reconciliation,
    certifiedDigest: report.certifiedDigest,
    quarantineSample: report.quarantine?.slice(0, 20),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();