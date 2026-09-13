import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { getFatePriceProviderPolicy } from './provider-policy.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

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
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
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

function topLevelObjectProperty(source, property) {
  if (!source || source[0] !== '{') return null;
  let depth = 1;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const matcher = new RegExp(`^\\s*${property}\\s*:\\s*\\{`);

  for (let i = 1; i < source.length - 1; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }

    if (depth === 1) {
      const match = matcher.exec(source.slice(i));
      if (match) {
        const open = i + match[0].lastIndexOf('{');
        const end = findBalancedEnd(source, open, '{', '}');
        return end < 0 ? null : source.slice(open, end + 1);
      }
    }

    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  return null;
}

function integerProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(\\d+)`).exec(source);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function extractRootTcgplayerProductId(cardSource) {
  const root = balancedAfter(cardSource, /:\s*Card\s*=\s*\{/, '{', '}');
  if (!root) return null;
  return integerProperty(topLevelObjectProperty(root, 'thirdParty'), 'tcgplayer');
}

const collector = (value) => {
  try { return normaliseCollectorNumber(value); } catch { return null; }
};
const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

function providerPolicySnapshot() {
  const tcgplayer = getFatePriceProviderPolicy('tcgplayer-api');
  const ebay = getFatePriceProviderPolicy('ebay-api') || getFatePriceProviderPolicy('ebay-sold-api');
  const compact = (policy, key) => policy ? {
    key: policy.key,
    status: policy.status,
    acquisitionMode: policy.acquisitionMode,
    reviewedAt: policy.reviewedAt,
  } : { key, status: 'unreviewed' };
  return {
    tcgplayerApi: compact(tcgplayer, 'tcgplayer-api'),
    ebaySold: compact(ebay, 'ebay-sold-api'),
  };
}

export async function buildSecondaryReadinessAudit(db, { repoEvidence } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, { card, set });

  const { rows } = await db.query(`
    WITH eligible AS (
      SELECT i.id AS card_identity_id, i.variant_code, p.name, p.collector_number,
        COALESCE(rs.classifier_state, 'ACTIVE_UNPRICED') AS classifier_state
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE i.verification_status='verified'
        AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
    )
    SELECT e.*,
      EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings cm
        WHERE cm.card_identity_id=e.card_identity_id AND cm.source_name='cardmarket'
      ) AS has_cardmarket_mapping,
      ARRAY(
        SELECT DISTINCT tm.source_record_id
        FROM fatedrop_card_source_mappings tm
        WHERE tm.card_identity_id=e.card_identity_id AND tm.source_name='tcgdex'
        ORDER BY tm.source_record_id
      ) AS tcgdex_card_ids
    FROM eligible e
    WHERE NOT EXISTS (
      SELECT 1 FROM fatedrop_market_observations o
      WHERE o.card_identity_id=e.card_identity_id
        AND o.source_name='cardmarket'
        AND GREATEST(
          COALESCE(o.market_price,0), COALESCE(o.trend_price,0), COALESCE(o.avg_1d,0),
          COALESCE(o.avg_7d,0), COALESCE(o.avg_30d,0)
        ) > 0
    )
    ORDER BY e.card_identity_id
  `);

  const resolutions = [];
  const counts = { inputUnpriced: rows.length, sectionA_mappedCardmarket: 0, sectionB_unmappedCardmarket: 0 };
  const provisional = [];

  for (const row of rows) {
    const section = row.has_cardmarket_mapping ? 'A_MAPPED_CARDMARKET' : 'B_UNMAPPED_CARDMARKET';
    bump(counts, row.has_cardmarket_mapping ? 'sectionA_mappedCardmarket' : 'sectionB_unmappedCardmarket');
    const base = {
      cardIdentityId: row.card_identity_id,
      section,
      name: row.name,
      collectorNumber: row.collector_number,
      finish: row.variant_code,
      targetTier2Provider: 'tcgplayer',
    };

    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      bump(counts, 'HOLD_TCGDEX_LINK_COUNT');
      resolutions.push({ ...base, status: 'HOLD_TCGDEX_LINK_COUNT', tcgdexCardIds: row.tcgdex_card_ids });
      continue;
    }

    const tcgdexCardId = row.tcgdex_card_ids[0];
    const evidence = cardById.get(tcgdexCardId);
    if (!evidence) {
      bump(counts, 'HOLD_TCGDEX_EVIDENCE_MISSING');
      resolutions.push({ ...base, tcgdexCardId, status: 'HOLD_TCGDEX_EVIDENCE_MISSING' });
      continue;
    }

    const { card, set } = evidence;
    if (normaliseComparableName(row.name) !== normaliseComparableName(card.name)) {
      bump(counts, 'HOLD_TCGDEX_NAME_MISMATCH');
      resolutions.push({ ...base, tcgdexCardId, tcgdexName: card.name, status: 'HOLD_TCGDEX_NAME_MISMATCH' });
      continue;
    }
    if (!collector(row.collector_number) || collector(row.collector_number) !== collector(card.localId)) {
      bump(counts, 'HOLD_TCGDEX_COLLECTOR_MISMATCH');
      resolutions.push({ ...base, tcgdexCardId, tcgdexCollectorNumber: card.localId, status: 'HOLD_TCGDEX_COLLECTOR_MISMATCH' });
      continue;
    }

    let cardSource;
    try { cardSource = fs.readFileSync(card.sourcePath, 'utf8'); } catch {
      bump(counts, 'HOLD_TCGDEX_SOURCE_UNREADABLE');
      resolutions.push({ ...base, tcgdexCardId, status: 'HOLD_TCGDEX_SOURCE_UNREADABLE' });
      continue;
    }
    const tcgplayerProductId = extractRootTcgplayerProductId(cardSource);
    if (!tcgplayerProductId) {
      bump(counts, 'HOLD_TCGPLAYER_PRODUCT_ID_MISSING');
      resolutions.push({ ...base, tcgdexCardId, tcgdexSetId: set.tcgdexSetId, status: 'HOLD_TCGPLAYER_PRODUCT_ID_MISSING' });
      continue;
    }

    provisional.push({
      ...base,
      tcgdexCardId,
      tcgdexSetId: set.tcgdexSetId,
      tcgplayerProductId: String(tcgplayerProductId),
      sourceKey: `${tcgplayerProductId}|${row.variant_code}`,
      providerLaneVerificationRequired: true,
      status: 'TCGPLAYER_PRODUCT_ID_KNOWN_PROVIDER_VERIFICATION_REQUIRED',
    });
  }

  const sourceOwners = new Map();
  const collisions = new Set();
  for (const row of provisional) {
    const prior = sourceOwners.get(row.sourceKey);
    if (prior && prior !== row.cardIdentityId) collisions.add(row.sourceKey);
    else sourceOwners.set(row.sourceKey, row.cardIdentityId);
  }

  for (const row of provisional) {
    if (collisions.has(row.sourceKey)) {
      bump(counts, 'HOLD_TCGPLAYER_BATCH_SOURCE_COLLISION');
      resolutions.push({ ...row, status: 'HOLD_TCGPLAYER_BATCH_SOURCE_COLLISION' });
    } else {
      bump(counts, 'TCGPLAYER_PRODUCT_ID_KNOWN_PROVIDER_VERIFICATION_REQUIRED');
      resolutions.push(row);
    }
  }

  counts.tcgplayerProductCrosswalkReady = counts.TCGPLAYER_PRODUCT_ID_KNOWN_PROVIDER_VERIFICATION_REQUIRED || 0;
  counts.tcgplayerProductIdMissing = counts.HOLD_TCGPLAYER_PRODUCT_ID_MISSING || 0;
  counts.providerVerificationPending = counts.tcgplayerProductCrosswalkReady;
  counts.priceResolvedByThisAudit = 0;

  return {
    status: 'audit_complete',
    productionWrites: false,
    providerNetworkCalls: false,
    source: { tcgdexRevision: process.env.TCGDEX_REVISION || null },
    providerPolicy: providerPolicySnapshot(),
    policy: {
      exactSingleTcgdexCardRequired: true,
      exactCanonicalNameRequired: true,
      exactCollectorNumberRequired: true,
      canonicalFinishRemainsLocked: true,
      tcgplayerRootProductIdIsCrosswalkEvidenceOnly: true,
      tcgplayerPriceLaneMustBeVerifiedByApprovedProviderAccess: true,
      ebaySoldCompsNotQueriedUntilProviderPathReviewed: true,
      noFallbackPriceWritten: true,
      zeroGuess: true,
    },
    counts,
    resolutions,
  };
}

function assertExpected(report) {
  const expectedUnpriced = Number(process.env.EXPECTED_UNPRICED || 0);
  const expectedA = Number(process.env.EXPECTED_SECTION_A || 0);
  const expectedB = Number(process.env.EXPECTED_SECTION_B || 0);
  if (expectedUnpriced && report.counts.inputUnpriced !== expectedUnpriced) throw new Error(`Unpriced cohort drift: expected ${expectedUnpriced}, found ${report.counts.inputUnpriced}`);
  if (expectedA && report.counts.sectionA_mappedCardmarket !== expectedA) throw new Error(`Section A drift: expected ${expectedA}, found ${report.counts.sectionA_mappedCardmarket}`);
  if (expectedB && report.counts.sectionB_unmappedCardmarket !== expectedB) throw new Error(`Section B drift: expected ${expectedB}, found ${report.counts.sectionB_unmappedCardmarket}`);
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildSecondaryReadinessAudit(db);
    assertExpected(report);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, providerNetworkCalls: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/fateprice-secondary-readiness-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, providerNetworkCalls: report.providerNetworkCalls, providerPolicy: report.providerPolicy, counts: report.counts }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
