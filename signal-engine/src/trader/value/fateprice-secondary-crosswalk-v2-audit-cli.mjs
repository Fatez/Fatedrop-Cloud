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
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === openChar) depth += 1;
    else if (c === closeChar && --depth === 0) return i;
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

function topLevelProperty(source, property, openChar, closeChar) {
  if (!source || source[0] !== '{') return null;
  let depth = 1, quote = null, escaped = false, lineComment = false, blockComment = false;
  const matcher = new RegExp(`^\\s*${property}\\s*:\\s*\\${openChar}`);
  for (let i = 1; i < source.length - 1; i += 1) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === '\\') { escaped = true; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (depth === 1) {
      const match = matcher.exec(source.slice(i));
      if (match) {
        const open = i + match[0].lastIndexOf(openChar);
        const end = findBalancedEnd(source, open, openChar, closeChar);
        return end < 0 ? null : source.slice(open, end + 1);
      }
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  return null;
}

const topLevelObjectProperty = (source, property) => topLevelProperty(source, property, '{', '}');
const topLevelArrayProperty = (source, property) => topLevelProperty(source, property, '[', ']');

function quotedProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);
  return match ? match[2].trim() : null;
}
function integerProperty(source, property) {
  if (!source) return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*(\\d+)`).exec(source);
  const value = match ? Number(match[1]) : null;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function topLevelObjects(arraySource) {
  if (!arraySource || arraySource[0] !== '[') return [];
  const rows = [];
  let i = 1;
  while (i < arraySource.length - 1) {
    const open = arraySource.indexOf('{', i);
    if (open < 0) break;
    const end = findBalancedEnd(arraySource, open, '{', '}');
    if (end < 0) break;
    rows.push(arraySource.slice(open, end + 1));
    i = end + 1;
  }
  return rows;
}

export function parseRootTcgplayerEvidence(cardSource) {
  const root = balancedAfter(cardSource, /:\s*Card\s*=\s*\{/, '{', '}');
  if (!root) return { name: null, rootProductId: null, variants: [] };
  const name = quotedProperty(topLevelObjectProperty(root, 'name'), 'en');
  const rootProductId = integerProperty(topLevelObjectProperty(root, 'thirdParty'), 'tcgplayer');
  const variants = topLevelObjects(topLevelArrayProperty(root, 'variants')).map((variant) => ({
    type: String(quotedProperty(variant, 'type') || '').trim().toLowerCase(),
    subtype: String(quotedProperty(variant, 'subtype') || '').trim().toLowerCase(),
    foil: String(quotedProperty(variant, 'foil') || '').trim().toLowerCase(),
    tcgplayerProductId: integerProperty(topLevelObjectProperty(variant, 'thirdParty'), 'tcgplayer'),
  }));
  return { name, rootProductId, variants };
}

function selectExactProduct(parsed, finish) {
  const acceptable = finish === 'holo' ? new Set(['holo']) : new Set(['normal', 'standard']);
  const exact = parsed.variants.filter((v) => v.tcgplayerProductId && acceptable.has(v.type));
  const ids = [...new Set(exact.map((v) => v.tcgplayerProductId))];
  if (ids.length === 1) return { status: 'MATCH', productId: ids[0], basis: 'tcgdex_exact_variant_type' };
  if (ids.length > 1) return { status: 'HOLD_MULTIPLE_TCGPLAYER_VARIANT_PRODUCTS', candidates: ids.map(String) };
  if (parsed.rootProductId) return { status: 'MATCH', productId: parsed.rootProductId, basis: 'tcgdex_root_product_provider_lane_required' };
  return { status: 'HOLD_TCGPLAYER_PRODUCT_ID_MISSING' };
}

const collector = (value) => { try { return normaliseCollectorNumber(value); } catch { return null; } };
const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

export async function buildAudit(db) {
  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, { card, set });

  const { rows } = await db.query(`
    WITH eligible AS (
      SELECT i.id AS card_identity_id, i.variant_code, p.name, p.collector_number
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE i.verification_status='verified' AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
    )
    SELECT e.*,
      EXISTS (SELECT 1 FROM fatedrop_card_source_mappings cm WHERE cm.card_identity_id=e.card_identity_id AND cm.source_name='cardmarket') AS has_cardmarket_mapping,
      ARRAY(SELECT DISTINCT tm.source_record_id FROM fatedrop_card_source_mappings tm WHERE tm.card_identity_id=e.card_identity_id AND tm.source_name='tcgdex' ORDER BY tm.source_record_id) AS tcgdex_card_ids
    FROM eligible e
    WHERE NOT EXISTS (
      SELECT 1 FROM fatedrop_market_observations o
      WHERE o.card_identity_id=e.card_identity_id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0
    )
    ORDER BY e.card_identity_id
  `);

  const counts = { inputUnpriced: rows.length, sectionA: 0, sectionB: 0 };
  const resolutions = [];
  const provisional = [];

  for (const row of rows) {
    const section = row.has_cardmarket_mapping ? 'A' : 'B';
    bump(counts, section === 'A' ? 'sectionA' : 'sectionB');
    const base = { cardIdentityId: row.card_identity_id, section, name: row.name, collectorNumber: row.collector_number, finish: row.variant_code };
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      bump(counts, 'HOLD_TCGDEX_LINK_COUNT'); resolutions.push({ ...base, status: 'HOLD_TCGDEX_LINK_COUNT' }); continue;
    }
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const evidence = cardById.get(tcgdexCardId);
    if (!evidence) { bump(counts, 'HOLD_TCGDEX_EVIDENCE_MISSING'); resolutions.push({ ...base, tcgdexCardId, status: 'HOLD_TCGDEX_EVIDENCE_MISSING' }); continue; }
    let source;
    try { source = fs.readFileSync(evidence.card.sourcePath, 'utf8'); } catch { bump(counts, 'HOLD_TCGDEX_SOURCE_UNREADABLE'); resolutions.push({ ...base, tcgdexCardId, status: 'HOLD_TCGDEX_SOURCE_UNREADABLE' }); continue; }
    const parsed = parseRootTcgplayerEvidence(source);
    if (!parsed.name || normaliseComparableName(parsed.name) !== normaliseComparableName(row.name)) {
      bump(counts, 'HOLD_TCGDEX_ROOT_NAME_MISMATCH'); resolutions.push({ ...base, tcgdexCardId, tcgdexRootName: parsed.name, status: 'HOLD_TCGDEX_ROOT_NAME_MISMATCH' }); continue;
    }
    if (!collector(row.collector_number) || collector(row.collector_number) !== collector(evidence.card.localId)) {
      bump(counts, 'HOLD_TCGDEX_COLLECTOR_MISMATCH'); resolutions.push({ ...base, tcgdexCardId, status: 'HOLD_TCGDEX_COLLECTOR_MISMATCH' }); continue;
    }
    const selected = selectExactProduct(parsed, row.variant_code);
    if (selected.status !== 'MATCH') {
      bump(counts, selected.status); resolutions.push({ ...base, tcgdexCardId, status: selected.status, candidates: selected.candidates || [] }); continue;
    }
    provisional.push({ ...base, tcgdexCardId, tcgplayerProductId: String(selected.productId), matchBasis: selected.basis, sourceKey: `${selected.productId}|${row.variant_code}`, status: 'TCGPLAYER_CROSSWALK_READY_PROVIDER_LANE_REQUIRED' });
  }

  const owner = new Map(), collisions = new Set();
  for (const row of provisional) {
    const prior = owner.get(row.sourceKey);
    if (prior && prior !== row.cardIdentityId) collisions.add(row.sourceKey); else owner.set(row.sourceKey, row.cardIdentityId);
  }
  for (const row of provisional) {
    if (collisions.has(row.sourceKey)) { bump(counts, 'HOLD_TCGPLAYER_BATCH_SOURCE_COLLISION'); resolutions.push({ ...row, status: 'HOLD_TCGPLAYER_BATCH_SOURCE_COLLISION' }); }
    else { bump(counts, 'TCGPLAYER_CROSSWALK_READY_PROVIDER_LANE_REQUIRED'); resolutions.push(row); }
  }
  counts.crosswalkReady = counts.TCGPLAYER_CROSSWALK_READY_PROVIDER_LANE_REQUIRED || 0;
  counts.priceResolved = 0;

  return {
    status: 'audit_complete', productionWrites: false, providerNetworkCalls: false,
    source: { tcgdexRevision: process.env.TCGDEX_REVISION || null },
    providerPolicy: {
      tcgplayerApi: getFatePriceProviderPolicy('tcgplayer-api')?.status || 'unreviewed',
      ebaySold: getFatePriceProviderPolicy('ebay-sold-api')?.status || 'unreviewed',
    },
    policy: { exactRootName: true, exactCollector: true, exactVariantTypePreferred: true, rootProductRequiresProviderLaneVerification: true, noPriceWrites: true, zeroGuess: true },
    counts, resolutions,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildAudit(db);
    if (report.counts.inputUnpriced !== Number(process.env.EXPECTED_UNPRICED || 819)) throw new Error(`Unpriced cohort drift: ${report.counts.inputUnpriced}`);
    if (report.counts.sectionA !== Number(process.env.EXPECTED_SECTION_A || 94)) throw new Error(`Section A drift: ${report.counts.sectionA}`);
    if (report.counts.sectionB !== Number(process.env.EXPECTED_SECTION_B || 725)) throw new Error(`Section B drift: ${report.counts.sectionB}`);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, providerNetworkCalls: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally { db.release(); await pool.end(); }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/fateprice-secondary-crosswalk-v2-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, providerPolicy: report.providerPolicy, counts: report.counts }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
