import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { build as buildPrimary } from './cardmarket-resolution-aware-root-recovery-cli.mjs';

const POLICY = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const PARENT_SUFFIXES = Object.freeze([
  ' Trainer Gallery',
  ' Galarian Gallery',
  ' Classic Collection',
]);

const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
const sourceKey = (productId, variantKey) => `${productId}|${variantKey}`;

function stripDiacritics(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function relaxedComparableName(value) {
  return normaliseComparableName(
    stripDiacritics(value)
      .replace(/♀/g, ' female ')
      .replace(/♂/g, ' male ')
      .replace(/[☆★]/g, ' gold star ')
      .replace(/\bLV\.?\s*X\b/gi, ' lvx ')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function stripProviderDescriptors(value) {
  let text = String(value || '').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i, 'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i, 'Nidoran male');
  const trailing = /\s+\[[^[\]]+\]\s*$/;
  while (trailing.test(text)) text = text.replace(trailing, '').trim();
  return text;
}

function providerDescriptorTerms(value) {
  const groups = [...String(value || '').matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  const terms = [];
  for (const group of groups) {
    for (const part of group.split('|')) {
      const normalized = relaxedComparableName(part);
      if (normalized && !/^\d+[a-z]?$/.test(normalized)) terms.push(normalized);
    }
  }
  return [...new Set(terms)].sort();
}

function findBalancedEnd(source, start, openChar, closeChar) {
  if (source[start] !== openChar) return -1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === openChar) depth += 1;
    else if (c === closeChar) { depth -= 1; if (depth === 0) return i; }
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

function arrayProperty(source, property) {
  return balancedAfter(source, new RegExp(`\\b${property}\\s*:\\s*\\[`), '[', ']');
}
function objectProperty(source, property) {
  return balancedAfter(source, new RegExp(`\\b${property}\\s*:\\s*\\{`), '{', '}');
}
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
    .map((row) => quotedProperty(objectProperty(row, 'name'), 'en'))
    .filter(Boolean);
}
function tcgdexDescriptorEvidence(card) {
  try {
    const source = fs.readFileSync(card.sourcePath, 'utf8');
    return [...new Set([
      ...namesFromArray(source, 'attacks'),
      ...namesFromArray(source, 'abilities'),
    ].map(relaxedComparableName).filter(Boolean))].sort();
  } catch {
    return [];
  }
}
function sameTermSet(left, right) {
  return left.length > 0 && left.length === right.length && left.every((value, index) => value === right[index]);
}

function parentSetName(value) {
  const name = String(value || '').trim();
  for (const suffix of PARENT_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length).trim();
  }
  return null;
}

function buildCatalogueIndex(products) {
  const byExpansionName = new Map();
  const expansionNames = new Map();
  for (const product of products) {
    const expansionId = Number(product.sourceExpansionId);
    if (!Number.isSafeInteger(expansionId) || expansionId <= 0) continue;
    const base = relaxedComparableName(stripProviderDescriptors(product.name));
    if (!base) continue;
    const key = `${expansionId}|${base}`;
    const list = byExpansionName.get(key) || [];
    list.push(product);
    byExpansionName.set(key, list);
    let names = expansionNames.get(expansionId);
    if (!names) { names = new Set(); expansionNames.set(expansionId, names); }
    names.add(base);
  }
  return { byExpansionName, expansionNames };
}

function exactScopeForSet(set, setOverrides, repoByName) {
  const override = Number(setOverrides.get(set.tcgdexSetId));
  if (Number.isSafeInteger(override) && override > 0) return { expansionId: override, proof: 'production_cardmarket_set_mapping' };
  const explicit = Number(set.cardmarketExpansionId);
  if (Number.isSafeInteger(explicit) && explicit > 0) return { expansionId: explicit, proof: 'tcgdex_explicit_cardmarket_expansion' };
  const parentName = parentSetName(set.setName);
  if (!parentName) return null;
  const parent = repoByName.get(relaxedComparableName(parentName));
  if (!parent) return null;
  const parentOverride = Number(setOverrides.get(parent.tcgdexSetId));
  if (Number.isSafeInteger(parentOverride) && parentOverride > 0) return { expansionId: parentOverride, proof: 'derived_parent_set_production_mapping', parentSet: parent.setName };
  const parentExplicit = Number(parent.cardmarketExpansionId);
  if (Number.isSafeInteger(parentExplicit) && parentExplicit > 0) return { expansionId: parentExplicit, proof: 'derived_parent_set_tcgdex_expansion', parentSet: parent.setName };
  return null;
}

function derivedExpansionScope(set, expansionNames) {
  const canonicalNames = new Set(set.cards.map((card) => relaxedComparableName(card.name)).filter(Boolean));
  if (canonicalNames.size < 5) return null;
  const ranked = [];
  for (const [expansionId, names] of expansionNames.entries()) {
    let overlap = 0;
    for (const name of canonicalNames) if (names.has(name)) overlap += 1;
    if (overlap < 5) continue;
    const coverage = overlap / canonicalNames.size;
    const precision = overlap / names.size;
    const score = coverage * 0.7 + precision * 0.3;
    ranked.push({ expansionId, overlap, coverage, precision, score });
  }
  ranked.sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.expansionId - b.expansionId);
  const top = ranked[0];
  if (!top || top.coverage < 0.9 || top.precision < 0.7 || top.overlap < Math.min(12, Math.max(5, Math.ceil(canonicalNames.size * 0.25)))) return null;
  const second = ranked[1];
  if (second && top.score - second.score < 0.08 && second.overlap >= Math.floor(top.overlap * 0.9)) return null;
  return { expansionId: top.expansionId, proof: 'dominant_set_name_signature', signature: top };
}

export function chooseRelaxedProduct({ identity, card, set, scope, catalogueIndex }) {
  if (!scope) return { status: 'HOLD_EXPANSION_MISMATCH' };
  const canonicalName = relaxedComparableName(identity.name);
  if (!canonicalName || canonicalName !== relaxedComparableName(card.name)) return { status: 'HOLD_COLLECTOR_NUMBER_MISMATCH' };

  const pool = catalogueIndex.byExpansionName.get(`${scope.expansionId}|${canonicalName}`) || [];
  if (pool.length === 0) return { status: 'HOLD_NO_MATCH' };

  const sameNameCards = set.cards.filter((candidate) => relaxedComparableName(candidate.name) === canonicalName);
  if (pool.length === 1 && sameNameCards.length === 1) {
    return { status: 'MATCH', product: pool[0], matchBasis: 'unique_name_within_exact_set_scope' };
  }

  const descriptors = tcgdexDescriptorEvidence(card);
  if (descriptors.length) {
    const exact = pool.filter((product) => sameTermSet(providerDescriptorTerms(product.name), descriptors));
    if (exact.length === 1) return { status: 'MATCH', product: exact[0], matchBasis: 'exact_attack_ability_descriptor_set' };
    if (exact.length > 1) return { status: 'HOLD_MULTIPLE_PRODUCTS', candidates: exact.map((product) => String(product.sourceRecordId)) };
  }

  return { status: 'HOLD_MULTIPLE_PRODUCTS', candidates: pool.map((product) => String(product.sourceRecordId)) };
}

function laneHasAnyField(row, lane) {
  if (!row) return false;
  const fields = lane === 'holo'
    ? ['avg-holo', 'low-holo', 'trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
    : ['avg', 'low', 'trend', 'avg1', 'avg7', 'avg30'];
  return fields.some((field) => row[field] != null);
}

export async function build(db, { sources, repoEvidence } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const sharedSources = { catalogue: { artifact: catalogue, products }, guide: { artifact: guide, snapshot } };
  const primary = await buildPrimary(db, { repoEvidence: repo, sources: sharedSources });
  const targets = primary.resolutions.filter((row) => row.status === 'HOLD_NO_ROOT_CARDMARKET_PRODUCT');

  const cardById = new Map();
  const setByCardId = new Map();
  const repoByName = new Map();
  for (const set of repo.sets) {
    repoByName.set(relaxedComparableName(set.setName), set);
    for (const card of set.cards) {
      cardById.set(card.tcgdexCardId, card);
      setByCardId.set(card.tcgdexCardId, set);
    }
  }

  const { rows: setMappings } = await db.query(`
    SELECT t.source_record_id AS tcgdex_set_id, cm.source_record_id AS cardmarket_expansion_id
    FROM fatedrop_card_sets s
    JOIN fatedrop_card_set_source_mappings t ON t.set_id=s.id AND t.source_name='tcgdex'
    JOIN fatedrop_card_set_source_mappings cm ON cm.set_id=s.id AND cm.source_name='cardmarket'`);
  const setOverrides = new Map(setMappings.map((row) => [row.tcgdex_set_id, row.cardmarket_expansion_id]));

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existing) {
    const key = sourceKey(row.source_record_id, row.source_variant_key);
    const prior = owners.get(key);
    owners.set(key, prior && prior !== row.card_identity_id ? '__CONFLICT__' : row.card_identity_id);
  }
  const identityOwned = new Set(existing.map((row) => row.card_identity_id));

  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const catalogueIndex = buildCatalogueIndex(products);
  const reasons = {};
  const resolutions = [];
  const raw = [];
  const bump = (status) => { reasons[status] = (reasons[status] || 0) + 1; };

  for (const target of targets) {
    const identity = target.identity;
    if (identityOwned.has(identity.cardIdentityId)) {
      bump('HOLD_IDENTITY_ALREADY_OWNED');
      resolutions.push({ identity, status: 'HOLD_IDENTITY_ALREADY_OWNED' });
      continue;
    }
    const tcgdexCardId = target.tcgdexCardId;
    const card = cardById.get(tcgdexCardId);
    const set = setByCardId.get(tcgdexCardId);
    if (!card || !set) {
      bump('HOLD_NO_MATCH');
      resolutions.push({ identity, status: 'HOLD_NO_MATCH', tcgdexCardId });
      continue;
    }

    let scope = exactScopeForSet(set, setOverrides, repoByName);
    if (!scope) scope = derivedExpansionScope(set, catalogueIndex.expansionNames);
    const selected = chooseRelaxedProduct({ identity, card, set, scope, catalogueIndex });
    if (selected.status !== 'MATCH') {
      bump(selected.status);
      resolutions.push({ identity, tcgdexCardId, scope, ...selected });
      continue;
    }

    const policy = POLICY[identity.variantCode];
    const sourceRecordId = String(selected.product.sourceRecordId);
    const owner = owners.get(sourceKey(sourceRecordId, policy.sourceVariantKey));
    if (owner && owner !== identity.cardIdentityId) {
      bump('HOLD_PRODUCT_ALREADY_OWNED');
      resolutions.push({ identity, tcgdexCardId, scope, sourceRecordId, status: 'HOLD_PRODUCT_ALREADY_OWNED', existingCardIdentityId: owner });
      continue;
    }

    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow) {
      bump('HOLD_NO_SUPPORTED_PRICE');
      resolutions.push({ identity, tcgdexCardId, scope, sourceRecordId, status: 'HOLD_NO_SUPPORTED_PRICE' });
      continue;
    }
    if (!hasMeaningfulCardmarketLane(priceRow, policy.priceLane)) {
      const status = laneHasAnyField(priceRow, policy.priceLane) ? 'HOLD_NO_SUPPORTED_PRICE' : 'HOLD_PRICE_LANE_MISSING';
      bump(status);
      resolutions.push({ identity, tcgdexCardId, scope, sourceRecordId, status });
      continue;
    }

    raw.push({
      id: stableId('fdcardmap', [identity.cardIdentityId, 'cardmarket', sourceRecordId, policy.sourceVariantKey]),
      cardIdentityId: identity.cardIdentityId,
      name: identity.name,
      collectorNumber: identity.collectorNumber,
      variantCode: identity.variantCode,
      tcgdexCardId,
      sourceRecordId,
      sourceVariantKey: policy.sourceVariantKey,
      sourceVersion: catalogue.sha256,
      cardmarketProductName: selected.product.name,
      sourceExpansionId: scope.expansionId,
      priceLane: policy.priceLane,
      proof: {
        method: 'relaxed_secondary_official_catalogue',
        scopeProof: scope,
        matchBasis: selected.matchBasis,
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        canonicalFinishLocked: identity.variantCode,
      },
    });
    resolutions.push({ identity, tcgdexCardId, scope, sourceRecordId, status: 'SAFE_MAPPING_CANDIDATE', matchBasis: selected.matchBasis });
  }

  const batchOwners = new Map();
  const collisionKeys = new Set();
  for (const row of raw) {
    const key = sourceKey(row.sourceRecordId, row.sourceVariantKey);
    const prior = batchOwners.get(key);
    if (prior && prior !== row.cardIdentityId) collisionKeys.add(key);
    else batchOwners.set(key, row.cardIdentityId);
  }
  const candidates = raw.filter((row) => !collisionKeys.has(sourceKey(row.sourceRecordId, row.sourceVariantKey)));
  const heldBatch = raw.length - candidates.length;
  if (heldBatch) reasons.HOLD_PRODUCT_ALREADY_OWNED = (reasons.HOLD_PRODUCT_ALREADY_OWNED || 0) + heldBatch;

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
    },
    policy: {
      targetOnlyPrimaryNoRootHolds: true,
      officialCardmarketDownloadOnly: true,
      apiSearchNotRequired: true,
      punctuationAndDiacriticNormalizationAllowedForDiscovery: true,
      subsetParentScopeAllowedOnlyFromExactNamedParent: true,
      derivedSetScopeRequiresDominantWholeSetSignature: true,
      duplicateNamesRequireExactAttackAbilityDescriptorEvidence: true,
      canonicalFinishSelectsPriceLane: true,
      positiveSupportedPriceRequired: true,
      ownershipFailClosed: true,
      zeroGuess: true,
    },
    counts: {
      inputNoRoot: targets.length,
      preBatchSafe: raw.length,
      safeExactMappings: candidates.length,
      held: targets.length - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    },
    reasons,
    candidates,
    resolutions,
  };
}

export async function persist(db, report) {
  if (report.status !== 'audit_complete') throw new Error('Secondary recovery audit is not complete');
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-relaxed-secondary-cardmarket-recovery'))`);
    let insertedMappings = 0;
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT i.id,i.variant_code,i.language_code,i.verification_status,rs.classifier_state
        FROM fatedrop_card_identities i
        LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
        WHERE i.id=$1 FOR UPDATE`, [row.cardIdentityId]);
      const current = target.rows[0];
      if (!current || current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(current.classifier_state)) throw new Error(`Resolution state changed: ${row.cardIdentityId}`);
      const canonical = await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (canonical.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);
      const source = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`, [row.sourceRecordId, row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);
      const now = Date.now();
      const result = await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,now]);
      insertedMappings += result.rowCount;
    }
    await db.query('COMMIT');
    return { insertedMappings };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    const expected = Number(process.env.EXPECTED_NO_ROOT || 0);
    if (expected > 0 && report.counts.inputNoRoot !== expected) throw new Error(`No-root cohort drift: expected ${expected}, found ${report.counts.inputNoRoot}`);
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
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-relaxed-secondary-recovery.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, counts: report.counts, reasons: report.reasons, persistence: report.persistence }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
