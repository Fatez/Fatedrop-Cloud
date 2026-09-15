import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { reviewedCardmarketUrl } from './cardmarket-url-first-rebuild.mjs';

const BASE_REPORT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-rebuild.json');
const EVIDENCE_PATH = path.resolve('evidence/cardmarket-url-first-rebuild-source-2026-09-15.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sourceVariantKey = (variantCode) => variantCode === 'holo' ? 'holo' : 'normal';
const priceLane = (variantCode) => variantCode === 'holo' ? 'holo' : 'standard';

function extractCardmarketIds(html) {
  const ids = new Set();
  for (const re of [
    /"cardmarket_id"\s*:\s*(\d+)/gi,
    /\bCM\s+(\d{5,})\b/gi,
    /cardmarket[^\d]{0,40}(\d{5,})/gi,
  ]) {
    for (const match of html.matchAll(re)) ids.add(match[1]);
  }
  return [...ids];
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(15000, retryAfter * 1000);
  return [750, 1500, 3000, 5000, 8000][Math.min(attempt, 4)];
}

async function fetchTcggoExact(tcgId, { attempts = 5 } = {}) {
  const url = new URL('https://www.tcggo.com/api-playground');
  url.searchParams.set('ep', 'cards.search');
  url.searchParams.set('game', 'pokemon');
  url.searchParams.set('q[tcgid]', tcgId);
  url.searchParams.set('q[sort]', 'relevance');
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'FateDrop-Cardmarket-Rebuild-Audit/1.0',
        },
        redirect: 'follow',
      });
      const html = await response.text();
      last = {
        url: url.toString(),
        status: response.status,
        ok: response.ok,
        hasTcgId: html.toLowerCase().includes(String(tcgId).toLowerCase()),
        cardmarketIds: extractCardmarketIds(html),
      };
      if (response.ok) return last;
      if (![403, 408, 425, 429, 500, 502, 503, 504].includes(response.status)) return last;
      if (attempt + 1 < attempts) await sleep(retryDelay(response, attempt));
    } catch (error) {
      last = { url: url.toString(), status: 'error', error: error instanceof Error ? error.message : String(error), hasTcgId: false, cardmarketIds: [] };
      if (attempt + 1 < attempts) await sleep([750, 1500, 3000, 5000, 8000][Math.min(attempt, 4)]);
    }
  }
  return last;
}

function baseScopeFor(baseRow) {
  const ids = new Set();
  for (const candidate of baseRow?.model?.candidates || []) {
    if (candidate?.sourceRecordId) ids.add(String(candidate.sourceRecordId));
  }
  if (baseRow?.model?.sourceRecordId) ids.add(String(baseRow.model.sourceRecordId));
  return ids;
}

function chooseCandidate(target, tcggo, productById, baseRow) {
  if (!tcggo?.ok || !tcggo?.hasTcgId) return { status: 'held', reason: 'TCGGO_EXACT_LOOKUP_FAILED', candidates: [] };
  const rawIds = [...new Set(tcggo.cardmarketIds.map(String))];
  if (rawIds.length === 0) return { status: 'held', reason: 'TCGGO_NO_CARDMARKET_ID', candidates: [] };
  let products = rawIds.map((id) => productById.get(id)).filter(Boolean);
  if (products.length === 0) return { status: 'held', reason: 'TCGGO_IDS_ABSENT_FROM_OFFICIAL_CARDMARKET_CATALOGUE', candidates: rawIds };

  const nameCompatible = products.filter((product) => rootProductNameMatches(target.name, product.name));
  if (nameCompatible.length > 0) products = nameCompatible;

  const expansionId = baseRow?.expansion?.expansionId ? String(baseRow.expansion.expansionId) : null;
  if (expansionId) {
    const inExpansion = products.filter((product) => String(product.sourceExpansionId ?? '') === expansionId);
    if (inExpansion.length > 0) products = inExpansion;
  }

  const baseScope = baseScopeFor(baseRow);
  if (baseScope.size > 0) {
    const scoped = products.filter((product) => baseScope.has(String(product.sourceRecordId)));
    if (scoped.length > 0) products = scoped;
  }

  const unique = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  if (unique.size !== 1) {
    return {
      status: 'held',
      reason: unique.size === 0 ? 'NO_VALID_CARDMARKET_PRODUCT_AFTER_FILTERS' : 'MULTIPLE_VALID_CARDMARKET_PRODUCTS',
      candidates: [...unique.keys()],
      rawIds,
    };
  }
  const [sourceRecordId, product] = [...unique.entries()][0];
  return { status: 'resolved', sourceRecordId, product, rawIds };
}

export async function build(db) {
  const [baseReportRaw, evidenceRaw] = await Promise.all([
    readFile(BASE_REPORT(), 'utf8'),
    readFile(EVIDENCE_PATH, 'utf8'),
  ]);
  const baseReport = JSON.parse(baseReportRaw);
  const evidence = JSON.parse(evidenceRaw);
  if (baseReport?.status !== 'audit_complete' || baseReport?.productionWrites !== false) throw new Error('Read-only base report required');
  if (evidence?.policy?.productionWrites !== false) throw new Error('Read-only source evidence required');

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: targets } = await db.query(`
    SELECT i.id AS card_identity_id,i.variant_code,p.name,p.collector_number,s.name AS set_name,
      p.attributes->'artwork'->>'sourceRecordId' AS tcgdex_id
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=p.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
    ORDER BY s.name,p.collector_number,p.name,i.variant_code,i.id`);

  const baseRows = [
    ...(baseReport.currentUnmappedResidual || []),
    ...(baseReport.newMappingCandidates || []),
  ];
  const baseByIdentity = new Map(baseRows.map((row) => [row.cardIdentityId, row]));
  const ownerCache = new Map();
  const getOwners = async (sourceRecordId, variantKey) => {
    const key = `${sourceRecordId}|${variantKey}`;
    if (ownerCache.has(key)) return ownerCache.get(key);
    const { rows } = await db.query(`
      SELECT card_identity_id FROM fatedrop_card_source_mappings
      WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,
      [sourceRecordId, variantKey]);
    const owners = rows.map((row) => row.card_identity_id);
    ownerCache.set(key, owners);
    return owners;
  };

  const counts = {
    targets: targets.length,
    exactTcgIdAvailable: 0,
    tcggoLookupOk: 0,
    tcggoLookupFailed: 0,
    exactProductResolved: 0,
    exactProductHeld: 0,
    sourceOwnedConflict: 0,
    batchCollisionRows: 0,
    safeMappings: 0,
    safeTargetLanePriceable: 0,
    safeHoloBaseLaneOnly: 0,
    safeNoPriceLane: 0,
  };
  const resolved = [];
  const held = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const baseRow = baseByIdentity.get(target.card_identity_id) || null;
    const reviewedUrl = baseRow?.reviewedCardmarketUrl || reviewedCardmarketUrl({
      setName: target.set_name,
      name: target.name,
      collectorNumber: target.collector_number,
      variantCode: target.variant_code,
    }, evidence.setSlugOverrides);
    if (!target.tcgdex_id) {
      held.push({ ...target, reviewedCardmarketUrl: reviewedUrl, reason: 'TCG_ID_UNAVAILABLE' });
      counts.exactProductHeld += 1;
      continue;
    }
    counts.exactTcgIdAvailable += 1;

    const tcggo = await fetchTcggoExact(target.tcgdex_id);
    if (tcggo?.ok) counts.tcggoLookupOk += 1;
    else counts.tcggoLookupFailed += 1;

    const choice = chooseCandidate(target, tcggo, productById, baseRow);
    if (choice.status !== 'resolved') {
      counts.exactProductHeld += 1;
      held.push({
        ...target,
        reviewedCardmarketUrl: reviewedUrl,
        tcggo: { url: tcggo?.url, status: tcggo?.status, hasTcgId: tcggo?.hasTcgId, cardmarketIds: tcggo?.cardmarketIds || [] },
        reason: choice.reason,
        candidates: choice.candidates,
        rawIds: choice.rawIds,
      });
    } else {
      counts.exactProductResolved += 1;
      const variantKey = sourceVariantKey(target.variant_code);
      const owners = await getOwners(choice.sourceRecordId, variantKey);
      const foreignOwners = owners.filter((owner) => owner !== target.card_identity_id);
      const guide = priceById.get(choice.sourceRecordId);
      const standardPrice = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'standard'));
      const holoPrice = Boolean(guide && hasMeaningfulCardmarketLane(guide, 'holo'));
      const targetPrice = target.variant_code === 'holo' ? holoPrice : standardPrice;
      resolved.push({
        cardIdentityId: target.card_identity_id,
        setName: target.set_name,
        name: target.name,
        collectorNumber: target.collector_number,
        variantCode: target.variant_code,
        tcgId: target.tcgdex_id,
        reviewedCardmarketUrl: reviewedUrl,
        tcggo: { url: tcggo.url, status: tcggo.status, cardmarketIds: tcggo.cardmarketIds },
        sourceRecordId: choice.sourceRecordId,
        sourceVariantKey: variantKey,
        cardmarketProductName: choice.product.name,
        cardmarketExpansionId: choice.product.sourceExpansionId ?? null,
        foreignOwners,
        priceEvidence: {
          standard: standardPrice,
          holo: holoPrice,
          targetLane: targetPrice,
          baseLaneOnlyForHolo: target.variant_code === 'holo' && !holoPrice && standardPrice,
        },
      });
    }
    if (index + 1 < targets.length) await sleep(300);
  }

  const keyCounts = new Map();
  for (const row of resolved) {
    const key = `${row.sourceRecordId}|${row.sourceVariantKey}`;
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const collisionKeys = new Set([...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  const safe = [];
  const conflicts = [];
  for (const row of resolved) {
    const key = `${row.sourceRecordId}|${row.sourceVariantKey}`;
    if (collisionKeys.has(key)) {
      counts.batchCollisionRows += 1;
      conflicts.push({ ...row, reason: 'BATCH_SOURCE_COLLISION', sourceKey: key });
      continue;
    }
    if (row.foreignOwners.length > 0) {
      counts.sourceOwnedConflict += 1;
      conflicts.push({ ...row, reason: 'SOURCE_KEY_ALREADY_OWNED' });
      continue;
    }
    counts.safeMappings += 1;
    if (row.priceEvidence.targetLane) counts.safeTargetLanePriceable += 1;
    else if (row.priceEvidence.baseLaneOnlyForHolo) counts.safeHoloBaseLaneOnly += 1;
    else counts.safeNoPriceLane += 1;
    safe.push(row);
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    counts,
    source: {
      identity: 'reviewed Cardmarket direct URL from canonical set + card/promo number + card name',
      crosswalk: 'TCGGO public exact TCG-ID search to Cardmarket product ID',
      price: 'Cardmarket public price guide',
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    },
    collisionKeys: [...collisionKeys].sort(),
    safeMappings: safe,
    conflicts,
    held,
  };
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
  const output = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-full.json');
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, counts: report.counts, collisionKeys: report.collisionKeys, held: report.held?.slice(0, 20), conflicts: report.conflicts?.slice(0, 20) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
