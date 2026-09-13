import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const POLICY = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const CENTRAL_FIELDS = Object.freeze({
  standard: Object.freeze(['trend', 'avg1', 'avg7', 'avg30']),
  holo: Object.freeze(['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']),
});

const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');
const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

function collector(value) {
  try { return normaliseCollectorNumber(String(value ?? '')); } catch { return null; }
}

export function hasSupportedCentralCardmarketLane(row, lane) {
  const fields = CENTRAL_FIELDS[lane];
  if (!row || !fields) return false;
  return fields.some((field) => {
    const value = Number(row[field]);
    return Number.isFinite(value) && value > 0;
  });
}

export function distinctExplicitCardmarketProductIds(card) {
  return [...new Set((card?.variants || [])
    .map((variant) => positiveInteger(variant?.cardmarketProductId))
    .filter(Boolean))]
    .sort((left, right) => left - right);
}

function findBalancedEnd(source, start, openChar, closeChar) {
  if (source[start] !== openChar) return -1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === openChar) depth += 1;
    else if (char === closeChar) { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

function balancedAfter(source, regex, openChar, closeChar) {
  const match = regex.exec(source);
  if (!match) return null;
  const start = source.indexOf(openChar, match.index + match[0].length - 1);
  if (start < 0) return null;
  const end = findBalancedEnd(source, start, openChar, closeChar);
  return end < 0 ? null : source.slice(start, end + 1);
}
function arrayProperty(source, property) { return balancedAfter(source, new RegExp(`\\b${property}\\s*:\\s*\\[`), '[', ']'); }
function objectProperty(source, property) { return balancedAfter(source, new RegExp(`\\b${property}\\s*:\\s*\\{`), '{', '}'); }
function quotedProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);
  return match ? match[2].trim() : null;
}
function topLevelObjects(arraySource) {
  if (!arraySource || arraySource[0] !== '[') return [];
  const rows = [];
  let index = 1;
  while (index < arraySource.length - 1) {
    const open = arraySource.indexOf('{', index);
    if (open < 0) break;
    const end = findBalancedEnd(arraySource, open, '{', '}');
    if (end < 0) break;
    rows.push(arraySource.slice(open, end + 1));
    index = end + 1;
  }
  return rows;
}
function namesFromArray(source, property) {
  const block = arrayProperty(source, property);
  if (!block) return [];
  return topLevelObjects(block)
    .map((object) => quotedProperty(objectProperty(object, 'name'), 'en'))
    .filter(Boolean);
}

export function tcgdexDescriptorEvidence(card) {
  try {
    const source = fs.readFileSync(card.sourcePath, 'utf8');
    return [...new Set([
      ...namesFromArray(source, 'attacks'),
      ...namesFromArray(source, 'abilities'),
    ].map(normaliseComparableName).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

export function providerDescriptorTerms(name) {
  const groups = [...String(name || '').matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  const terms = [];
  for (const group of groups) {
    for (const part of group.split('|')) {
      const value = normaliseComparableName(part);
      if (value && !/^\d+[a-z]?$/.test(value)) terms.push(value);
    }
  }
  return [...new Set(terms)].sort();
}

export function providerDescriptorIsUniqueSubset(providerTerms, tcgdexTerms) {
  if (!Array.isArray(providerTerms) || !providerTerms.length || !Array.isArray(tcgdexTerms) || !tcgdexTerms.length) return false;
  const exact = new Set(tcgdexTerms);
  return providerTerms.every((term) => exact.has(term));
}

function exactTcgdexIdentity(identity, card) {
  if (!card) return 'HOLD_TCGDEX_CARD_MISSING';
  if (!rootProductNameMatches(identity.name, card.name)) return 'HOLD_TCGDEX_NAME_MISMATCH';
  if (collector(identity.collectorNumber) !== collector(card.localId)) return 'HOLD_TCGDEX_COLLECTOR_MISMATCH';
  return null;
}

function ownershipReason(existingOwners, identityId, sourceRecordId, sourceVariantKey) {
  const owners = existingOwners.get(key(sourceRecordId, sourceVariantKey));
  if (!owners || owners.size === 0) return null;
  if (owners.size === 1 && owners.has(identityId)) return null;
  return 'HOLD_PRODUCT_ALREADY_OWNED';
}

function buildCandidate({ identity, tcgdexCardId, sourceRecordId, product, catalogueSha256, method, proof, priceRow }) {
  const policy = POLICY[identity.variantCode];
  const priceableNow = hasSupportedCentralCardmarketLane(priceRow, policy.priceLane);
  return Object.freeze({
    id: stableId('fdcardmap', [identity.cardIdentityId, 'cardmarket', sourceRecordId, policy.sourceVariantKey]),
    cardIdentityId: identity.cardIdentityId,
    setId: identity.setId,
    setName: identity.setName,
    name: identity.name,
    collectorNumber: identity.collectorNumber,
    variantCode: identity.variantCode,
    tcgdexCardId,
    sourceRecordId: String(sourceRecordId),
    sourceVariantKey: policy.sourceVariantKey,
    sourceVersion: catalogueSha256,
    cardmarketProductName: product.name,
    sourceExpansionId: product.sourceExpansionId ?? null,
    priceLane: policy.priceLane,
    priceableNow,
    proof: Object.freeze({ method, finishProofSource: 'canonical_fatedrop_identity', ...proof }),
  });
}

export async function build(db, { sources, repoEvidence } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  const setByCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) {
    cardById.set(card.tcgdexCardId, card);
    setByCardId.set(card.tcgdexCardId, set);
  }

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id,i.set_id,i.variant_code,p.name,p.collector_number,s.name AS set_name,rs.classifier_state,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND greatest(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const existingOwners = new Map();
  for (const row of existing) {
    const sourceKey = key(row.source_record_id, row.source_variant_key);
    const owners = existingOwners.get(sourceKey) || new Set();
    owners.add(row.card_identity_id);
    existingOwners.set(sourceKey, owners);
  }

  const { rows: setMappingRows } = await db.query(`
    SELECT set_id,source_record_id
    FROM fatedrop_card_set_source_mappings
    WHERE source_name='cardmarket'
    ORDER BY set_id,source_record_id`);
  const setOverrides = new Map();
  for (const row of setMappingRows) {
    const list = setOverrides.get(row.set_id) || [];
    if (!list.includes(String(row.source_record_id))) list.push(String(row.source_record_id));
    setOverrides.set(row.set_id, list);
  }

  const productsByExpansion = new Map();
  for (const product of products) {
    const expansionId = positiveInteger(product.sourceExpansionId);
    if (!expansionId) continue;
    const list = productsByExpansion.get(expansionId) || [];
    list.push(product);
    productsByExpansion.set(expansionId, list);
  }

  const reasons = {};
  const bump = (name) => { reasons[name] = (reasons[name] || 0) + 1; };
  const raw = [];
  const resolutions = [];

  for (const row of identities) {
    const identity = Object.freeze({
      cardIdentityId: row.id,
      setId: row.set_id,
      setName: row.set_name,
      variantCode: row.variant_code,
      name: row.name,
      collectorNumber: row.collector_number,
    });
    const policy = POLICY[identity.variantCode];
    if (!policy) { bump('HOLD_UNSUPPORTED_FINISH'); resolutions.push({ identity, status: 'HOLD_UNSUPPORTED_FINISH' }); continue; }
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      bump('HOLD_TCGDEX_LINK_COUNT'); resolutions.push({ identity, status: 'HOLD_TCGDEX_LINK_COUNT', tcgdexCardIds: row.tcgdex_card_ids }); continue;
    }
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    const set = setByCardId.get(tcgdexCardId);
    const identityHold = exactTcgdexIdentity(identity, card);
    if (identityHold) { bump(identityHold); resolutions.push({ identity, tcgdexCardId, status: identityHold }); continue; }

    // Lane 1: the exact pinned TCGdex card exposes one and only one Cardmarket
    // product ID across all of its published variants. FateDrop's already-reviewed
    // canonical finish chooses the source variant key; TCGdex is only the exact
    // card/product crosswalk here, never a price source.
    const explicitIds = distinctExplicitCardmarketProductIds(card);
    if (explicitIds.length === 1) {
      const sourceRecordId = String(explicitIds[0]);
      const product = productById.get(sourceRecordId);
      let hold = null;
      if (!product) hold = 'HOLD_EXPLICIT_PRODUCT_MISSING_FROM_OFFICIAL_CATALOGUE';
      else if (!rootProductNameMatches(identity.name, product.name)) hold = 'HOLD_EXPLICIT_PRODUCT_NAME_MISMATCH';
      else hold = ownershipReason(existingOwners, identity.cardIdentityId, sourceRecordId, policy.sourceVariantKey);
      if (!hold) {
        raw.push(buildCandidate({
          identity, tcgdexCardId, sourceRecordId, product,
          catalogueSha256: catalogue.sha256,
          method: 'pinned_tcgdex_single_cardmarket_product_across_variants_locked_finish',
          priceRow: priceById.get(sourceRecordId),
          proof: {
            tcgdexRevision: process.env.TCGDEX_REVISION || null,
            tcgdexSetId: set?.tcgdexSetId || null,
            tcgdexCardSourcePath: card.sourcePath,
            distinctExplicitProductIds: explicitIds,
          },
        }));
        resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: 'PRE_BATCH_SAFE', method: 'single_explicit_product' });
        continue;
      }
      bump(hold);
      resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: hold, method: 'single_explicit_product' });
      continue;
    }
    if (explicitIds.length > 1) {
      bump('HOLD_MULTIPLE_EXPLICIT_CARDMARKET_PRODUCTS');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_MULTIPLE_EXPLICIT_CARDMARKET_PRODUCTS', explicitIds });
      continue;
    }

    // Lane 2: Cardmarket often appends attack/ability descriptors to otherwise
    // identical product names. A provider descriptor is accepted only when every
    // descriptor term exists verbatim in the exact pinned TCGdex card evidence,
    // within one explicit Cardmarket expansion scope, and exactly one product wins.
    const overrides = setOverrides.get(identity.setId) || [];
    let expansionId = null;
    let expansionBasis = null;
    if (overrides.length === 1) {
      expansionId = positiveInteger(overrides[0]);
      expansionBasis = 'fatedrop_cardmarket_set_mapping';
    } else if (overrides.length > 1) {
      bump('HOLD_MULTIPLE_CARDMARKET_SET_SCOPES');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_MULTIPLE_CARDMARKET_SET_SCOPES', overrides });
      continue;
    } else {
      expansionId = positiveInteger(set?.cardmarketExpansionId);
      expansionBasis = 'pinned_tcgdex_cardmarket_expansion';
    }
    if (!expansionId) {
      bump('HOLD_NO_EXPLICIT_CARDMARKET_SET_SCOPE');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_NO_EXPLICIT_CARDMARKET_SET_SCOPE' });
      continue;
    }
    const descriptors = tcgdexDescriptorEvidence(card);
    if (!descriptors.length) {
      bump('HOLD_NO_TCGDEX_ATTACK_ABILITY_DESCRIPTOR');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_NO_TCGDEX_ATTACK_ABILITY_DESCRIPTOR', expansionId });
      continue;
    }
    const sameName = (productsByExpansion.get(expansionId) || []).filter((product) => rootProductNameMatches(identity.name, product.name));
    const descriptorMatches = sameName
      .map((product) => ({ product, terms: providerDescriptorTerms(product.name) }))
      .filter(({ terms }) => providerDescriptorIsUniqueSubset(terms, descriptors));
    if (descriptorMatches.length === 0) {
      bump('HOLD_NO_PROVIDER_DESCRIPTOR_SUBSET_MATCH');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_NO_PROVIDER_DESCRIPTOR_SUBSET_MATCH', expansionId, descriptors });
      continue;
    }
    if (descriptorMatches.length > 1) {
      bump('HOLD_MULTIPLE_PROVIDER_DESCRIPTOR_SUBSET_MATCHES');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_MULTIPLE_PROVIDER_DESCRIPTOR_SUBSET_MATCHES', expansionId, descriptors, products: descriptorMatches.map(({ product }) => String(product.sourceRecordId)) });
      continue;
    }
    const [{ product, terms }] = descriptorMatches;
    const sourceRecordId = String(product.sourceRecordId);
    const ownershipHold = ownershipReason(existingOwners, identity.cardIdentityId, sourceRecordId, policy.sourceVariantKey);
    if (ownershipHold) {
      bump(ownershipHold);
      resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: ownershipHold, method: 'descriptor_subset' });
      continue;
    }
    raw.push(buildCandidate({
      identity, tcgdexCardId, sourceRecordId, product,
      catalogueSha256: catalogue.sha256,
      method: 'scoped_unique_provider_descriptor_subset_match',
      priceRow: priceById.get(sourceRecordId),
      proof: {
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        tcgdexSetId: set?.tcgdexSetId || null,
        tcgdexCardSourcePath: card.sourcePath,
        expansionId,
        expansionBasis,
        providerDescriptorTerms: terms,
        exactTcgdexDescriptors: descriptors,
      },
    }));
    resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: 'PRE_BATCH_SAFE', method: 'descriptor_subset' });
  }

  // Never pick a winner if two canonical identities resolve to the same
  // Cardmarket product+finish key in this batch. Hold every member of the collision.
  const batchOwners = new Map();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    const owners = batchOwners.get(sourceKey) || new Set();
    owners.add(row.cardIdentityId);
    batchOwners.set(sourceKey, owners);
  }
  const collisionKeys = new Set([...batchOwners.entries()].filter(([, owners]) => owners.size > 1).map(([sourceKey]) => sourceKey));
  const candidates = raw.filter((row) => !collisionKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  const collisionRows = raw.filter((row) => collisionKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  if (collisionRows.length) reasons.HOLD_BATCH_SOURCE_COLLISION = collisionRows.length;

  const byMethod = {};
  const byVariant = {};
  for (const row of candidates) {
    byMethod[row.proof.method] = (byMethod[row.proof.method] || 0) + 1;
    byVariant[row.variantCode] = (byVariant[row.variantCode] || 0) + 1;
  }
  const priceableNow = candidates.filter((row) => row.priceableNow);

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    policy: Object.freeze({
      approvedPriceAcquisition: 'cardmarket-public-download',
      tcgdexUsedForMetadataCrosswalkOnly: true,
      canonicalFateDropFinishLocked: true,
      exactSingleTcgdexCardRequired: true,
      exactNameAndCollectorRequired: true,
      explicitProductPathRequiresOneProductAcrossAllTcgdexVariants: true,
      descriptorPathRequiresOneScopedSubsetWinner: true,
      sourceOwnershipFailClosed: true,
      batchCollisionsFailClosed: true,
      invalidAndUnresolvedResolutionStatesExcluded: true,
      lowPriceAloneDoesNotCountAsSupportedCentralFatePrice: true,
      zeroGuess: true,
    }),
    counts: Object.freeze({
      sectionB: identities.length,
      preBatchSafe: raw.length,
      safeExactMappings: candidates.length,
      supportedCentralPriceNow: priceableNow.length,
      mappedButNoSupportedCentralPrice: candidates.length - priceableNow.length,
      held: identities.length - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    }),
    byMethod: Object.freeze(byMethod),
    byVariant: Object.freeze(byVariant),
    reasons: Object.freeze(reasons),
    candidates: Object.freeze(candidates),
    collisionRows: Object.freeze(collisionRows),
    resolutions: Object.freeze(resolutions),
  });
}

export async function persist(db, report) {
  if (report.status !== 'audit_complete') throw new Error('Recovery audit is not complete');
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-approved-cardmarket-residual-recovery'))`);
    let insertedMappings = 0;
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT i.id,i.variant_code,i.language_code,i.verification_status
        FROM fatedrop_card_identities i WHERE i.id=$1 FOR UPDATE`, [row.cardIdentityId]);
      const current = target.rows[0];
      if (!current || current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) {
        throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      }
      const state = await db.query(`SELECT classifier_state FROM fatedrop_variant_resolution_state WHERE card_identity_id=$1`, [row.cardIdentityId]);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(state.rows[0]?.classifier_state)) {
        throw new Error(`Resolution state changed: ${row.cardIdentityId}`);
      }
      const canonical = await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (canonical.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);
      const source = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`, [row.sourceRecordId, row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);
      const now = Date.now();
      const result = await db.query(`INSERT INTO fatedrop_card_source_mappings(
        id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
      ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,now]);
      insertedMappings += result.rowCount;
    }
    await db.query('COMMIT');
    return Object.freeze({ insertedMappings });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

function assertExpectedRehearsal(report) {
  const expectedSectionB = Number(process.env.EXPECTED_SECTION_B || 0);
  const expectedSafe = Number(process.env.EXPECTED_SAFE_MAPPINGS || 0);
  const expectedCandidateDigest = String(process.env.EXPECTED_CANDIDATE_DIGEST || '').trim();
  const expectedCatalogue = String(process.env.EXPECTED_CARDMARKET_CATALOGUE_SHA256 || '').trim();
  const expectedGuide = String(process.env.EXPECTED_CARDMARKET_PRICE_GUIDE_SHA256 || '').trim();
  if (expectedSectionB > 0 && report.counts.sectionB !== expectedSectionB) throw new Error(`Section B drift: expected ${expectedSectionB}, found ${report.counts.sectionB}`);
  if (expectedSafe > 0 && report.counts.safeExactMappings !== expectedSafe) throw new Error(`Safe mapping drift: expected ${expectedSafe}, found ${report.counts.safeExactMappings}`);
  const candidateDigest = createHash('sha256').update(JSON.stringify(report.candidates)).digest('hex');
  if (expectedCandidateDigest && candidateDigest !== expectedCandidateDigest) throw new Error('Candidate manifest drift');
  if (expectedCatalogue && report.source.cardmarketCatalogueSha256 !== expectedCatalogue) throw new Error('Cardmarket catalogue snapshot drift');
  if (expectedGuide && report.source.cardmarketPriceGuideSha256 !== expectedGuide) throw new Error('Cardmarket price-guide snapshot drift');
  if (process.env.MAPPING_WRITE === 'true' && (!expectedSectionB || !expectedSafe || !expectedCandidateDigest || !expectedCatalogue || !expectedGuide)) {
    throw new Error('Production mapping writes require pinned Section B count, safe mapping count, candidate digest, catalogue SHA and price-guide SHA');
  }
  return candidateDigest;
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    const candidateDigest = assertExpectedRehearsal(report);
    report = { ...report, candidateDigest };
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persist(db, report);
      report = { ...report, status: 'write_complete', productionWrites: true, persistence };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-approved-residual-recovery.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, counts: report.counts, byMethod: report.byMethod, byVariant: report.byVariant, reasons: report.reasons, candidateDigest: report.candidateDigest, persistence: report.persistence }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
