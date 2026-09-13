import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { relaxedComparableName } from './cardmarket-relaxed-secondary-recovery-cli.mjs';

const SOURCE_VARIANT = Object.freeze({ standard: 'normal', holo: 'holo' });
const CENTRAL_FIELDS = Object.freeze({
  standard: Object.freeze(['avg', 'trend', 'avg1', 'avg7', 'avg30']),
  holo: Object.freeze(['avg-holo', 'trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']),
});

const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');

function stripProviderDescriptors(value) {
  let text = String(value || '').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i, 'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i, 'Nidoran male');
  const trailing = /\s+\[[^[\]]+\]\s*$/;
  while (trailing.test(text)) text = text.replace(trailing, '').trim();
  return text;
}

function bracketGroups(value) {
  return [...String(value || '').matchAll(/\[([^\]]+)\]/g)]
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
}

function compactCollector(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase().trim()
    .replace(/[\s._-]+/g, '');
  if (!text) return null;
  if (/^\d+$/.test(text)) return String(Number(text));
  const prefixed = /^([a-z]+)0*(\d+)([a-z]*)$/.exec(text);
  if (prefixed) return `${prefixed[1]}${Number(prefixed[2])}${prefixed[3]}`;
  return text;
}

function numericTail(value) {
  const text = compactCollector(value);
  if (!text) return null;
  const match = /^(?:[a-z]+)?(\d+)(?:[a-z]*)$/.exec(text);
  return match ? String(Number(match[1])) : null;
}

export function collectorTokenMatches({ providerName, collectorNumber, setName }) {
  const canonical = compactCollector(collectorNumber);
  if (!canonical) return [];
  const promo = /promo/i.test(String(setName || ''));
  const canonicalNumeric = numericTail(collectorNumber);
  const matches = [];
  for (const group of bracketGroups(providerName)) {
    const pieces = [group, ...group.split(/[|,;]/g)].map((part) => part.trim()).filter(Boolean);
    for (const piece of pieces) {
      const normalized = compactCollector(piece);
      if (!normalized) continue;
      if (normalized === canonical) {
        matches.push({ token: piece, basis: 'exact_normalized_collector_token' });
        continue;
      }
      // Numeric-only promo tokens are accepted only inside an already-proven
      // Cardmarket promo expansion. Prefix removal is therefore discovery aid,
      // never standalone set/identity proof.
      if (promo && /^\d+$/.test(normalized) && canonicalNumeric && normalized === canonicalNumeric) {
        matches.push({ token: piece, basis: 'promo_numeric_token_with_proven_expansion_scope' });
      }
    }
  }
  return matches;
}

function hasSupportedCentralLane(row, variantCode) {
  if (!row) return false;
  const fields = CENTRAL_FIELDS[variantCode] || [];
  return fields.some((field) => {
    const value = Number(row[field]);
    return Number.isFinite(value) && value > 0;
  });
}

function buildProductIndex(products) {
  const index = new Map();
  for (const product of products) {
    const expansionId = Number(product.sourceExpansionId);
    if (!Number.isSafeInteger(expansionId) || expansionId <= 0) continue;
    const base = relaxedComparableName(stripProviderDescriptors(product.name));
    if (!base) continue;
    const k = key(expansionId, base);
    const rows = index.get(k) || [];
    rows.push(product);
    index.set(k, rows);
  }
  return index;
}

export async function build(db) {
  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: false });
  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);

  const { rows: sets } = await db.query(`
    SELECT s.id AS set_id, s.name AS set_name,
           t.source_record_id AS tcgdex_set_id,
           cm.source_record_id AS cardmarket_expansion_override
    FROM fatedrop_card_sets s
    JOIN fatedrop_card_set_source_mappings t
      ON t.set_id=s.id AND t.source_name='tcgdex'
    LEFT JOIN fatedrop_card_set_source_mappings cm
      ON cm.set_id=s.id AND cm.source_name='cardmarket'
    WHERE s.verification_status='verified'`);

  const setScope = new Map();
  for (const row of sets) {
    const evidence = repo.bySetId.get(row.tcgdex_set_id);
    const override = Number(row.cardmarket_expansion_override);
    const explicit = Number(evidence?.cardmarketExpansionId);
    const expansionId = Number.isSafeInteger(override) && override > 0 ? override : explicit;
    if (Number.isSafeInteger(expansionId) && expansionId > 0) {
      setScope.set(row.set_id, { expansionId, setName: row.set_name, proof: Number.isSafeInteger(override) && override > 0 ? 'production_set_mapping' : 'tcgdex_explicit_expansion' });
    }
  }

  const { rows: identities } = await db.query(`
    SELECT i.id AS card_identity_id, i.set_id, i.variant_code,
           p.name, p.collector_number,
           COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') AS classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
          AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0
      )
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const sourceOwners = new Map();
  for (const row of existing) {
    const k = key(row.source_record_id, row.source_variant_key);
    const prior = sourceOwners.get(k);
    sourceOwners.set(k, prior && prior !== row.card_identity_id ? '__CONFLICT__' : row.card_identity_id);
  }

  const byExpansionBase = buildProductIndex(products);
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const reasons = {};
  const rows = [];
  const provisional = [];
  const bump = (status) => { reasons[status] = (reasons[status] || 0) + 1; };

  for (const identity of identities) {
    const scope = setScope.get(identity.set_id);
    const base = {
      cardIdentityId: identity.card_identity_id,
      setName: scope?.setName || null,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
    };
    if (!scope) {
      bump('HOLD_EXPLICIT_EXPANSION_SCOPE_MISSING');
      rows.push({ ...base, status: 'HOLD_EXPLICIT_EXPANSION_SCOPE_MISSING' });
      continue;
    }
    const pool = byExpansionBase.get(key(scope.expansionId, relaxedComparableName(identity.name))) || [];
    if (pool.length === 0) {
      bump('HOLD_NO_BASE_NAME_MATCH');
      rows.push({ ...base, scope, status: 'HOLD_NO_BASE_NAME_MATCH' });
      continue;
    }
    const tokenMatches = pool.map((product) => ({
      product,
      matches: collectorTokenMatches({ providerName: product.name, collectorNumber: identity.collector_number, setName: scope.setName }),
    })).filter((entry) => entry.matches.length > 0);
    if (tokenMatches.length === 0) {
      bump('HOLD_NO_EXACT_COLLECTOR_TOKEN');
      rows.push({ ...base, scope, status: 'HOLD_NO_EXACT_COLLECTOR_TOKEN', candidateProductIds: pool.map((p) => String(p.sourceRecordId)) });
      continue;
    }
    if (tokenMatches.length > 1) {
      bump('HOLD_MULTIPLE_EXACT_COLLECTOR_TOKENS');
      rows.push({ ...base, scope, status: 'HOLD_MULTIPLE_EXACT_COLLECTOR_TOKENS', candidateProductIds: tokenMatches.map((e) => String(e.product.sourceRecordId)) });
      continue;
    }

    const selected = tokenMatches[0];
    const sourceRecordId = String(selected.product.sourceRecordId);
    const sourceVariantKey = SOURCE_VARIANT[identity.variant_code];
    const owner = sourceOwners.get(key(sourceRecordId, sourceVariantKey));
    if (owner && owner !== identity.card_identity_id) {
      bump('HOLD_PRODUCT_ALREADY_OWNED');
      rows.push({ ...base, scope, sourceRecordId, status: 'HOLD_PRODUCT_ALREADY_OWNED', existingCardIdentityId: owner });
      continue;
    }
    if (!hasSupportedCentralLane(priceById.get(sourceRecordId), identity.variant_code)) {
      bump('HOLD_NO_SUPPORTED_CENTRAL_PRICE');
      rows.push({ ...base, scope, sourceRecordId, cardmarketProductName: selected.product.name, tokenEvidence: selected.matches, status: 'HOLD_NO_SUPPORTED_CENTRAL_PRICE' });
      continue;
    }

    provisional.push({
      ...base,
      scope,
      sourceRecordId,
      sourceVariantKey,
      cardmarketProductName: selected.product.name,
      tokenEvidence: selected.matches,
      status: 'SAFE_CARDMARKET_NATIVE_CANDIDATE',
    });
  }

  const batchOwners = new Map();
  const collisionKeys = new Set();
  for (const row of provisional) {
    const k = key(row.sourceRecordId, row.sourceVariantKey);
    const prior = batchOwners.get(k);
    if (prior && prior !== row.cardIdentityId) collisionKeys.add(k);
    else batchOwners.set(k, row.cardIdentityId);
  }
  for (const row of provisional) {
    if (collisionKeys.has(key(row.sourceRecordId, row.sourceVariantKey))) {
      bump('HOLD_BATCH_SOURCE_COLLISION');
      rows.push({ ...row, status: 'HOLD_BATCH_SOURCE_COLLISION' });
    } else {
      bump('SAFE_CARDMARKET_NATIVE_CANDIDATE');
      rows.push(row);
    }
  }

  const candidates = rows.filter((row) => row.status === 'SAFE_CARDMARKET_NATIVE_CANDIDATE');
  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    },
    policy: {
      approvedPublicCardmarketOnly: true,
      currentPricingEligibleSectionBOnly: true,
      exactProvenExpansionRequired: true,
      normalizedBaseNameRequired: true,
      collectorTokenMustBePresentInProviderProductName: true,
      promoNumericPrefixRemovalOnlyInsideProvenPromoExpansion: true,
      supportedCentralFieldsExcludeLowOnly: true,
      sourceOwnershipFailClosed: true,
      batchCollisionFailClosed: true,
      zeroGuess: true,
    },
    counts: {
      inputSectionB: identities.length,
      safeCardmarketNativeCandidates: candidates.length,
      held: identities.length - candidates.length,
    },
    reasons,
    candidates,
    rows,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    const expected = Number(process.env.EXPECTED_SECTION_B || 725);
    if (report.counts.inputSectionB !== expected) throw new Error(`Section B drift: expected ${expected}, found ${report.counts.inputSectionB}`);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-native-collector-token-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, candidates: report.candidates }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
