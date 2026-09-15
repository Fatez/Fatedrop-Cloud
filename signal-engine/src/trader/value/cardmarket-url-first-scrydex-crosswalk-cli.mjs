import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { reviewedCardmarketUrl } from './cardmarket-url-first-rebuild.mjs';

const SCRYDEX_BASE = 'https://api.scrydex.com/pokemon/v1/en/cards';
const PACE_MS = 225;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function productIdsFromScrydex(payload) {
  const found = new Set();
  const visit = (value, path = '') => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized.includes('cardmarket')) {
        if (Number.isSafeInteger(Number(child)) && Number(child) > 0) found.add(String(Number(child)));
        if (typeof child === 'string') {
          for (const match of child.matchAll(/\b(\d{5,9})\b/g)) found.add(match[1]);
        }
      }
      visit(child, nextPath);
    }
  };
  visit(payload);
  return [...found].sort((a, b) => Number(a) - Number(b));
}

async function fetchScrydexCard(tcgdexId) {
  const apiKey = String(process.env.SCRYDEX_API_KEY || '').trim();
  const teamId = String(process.env.SCRYDEX_TEAM_ID || '').trim();
  if (!apiKey || !teamId) throw new Error('SCRYDEX_API_KEY and SCRYDEX_TEAM_ID are required');
  const response = await fetch(`${SCRYDEX_BASE}/${encodeURIComponent(tcgdexId)}`, {
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
      'x-team-id': teamId,
      'user-agent': 'FateDrop-Cardmarket-URL-First-Audit/1.0',
    },
  });
  if (response.status === 404) return { status: 404, payload: null };
  if (!response.ok) throw new Error(`Scrydex HTTP ${response.status}`);
  return { status: response.status, payload: await response.json() };
}

function targetLane(variantCode) {
  return variantCode === 'holo' ? 'holo' : 'standard';
}

function setSlugOverrides() {
  return {
    'Crystal Guardians': 'EX-Crystal-Guardians',
    'Delta Species': 'EX-Delta-Species',
    'Deoxys': 'EX-Deoxys',
    'Dragon Frontiers': 'EX-Dragon-Frontiers',
    'Holon Phantoms': 'EX-Holon-Phantoms',
    'Legend Maker': 'EX-Legend-Maker',
    'Pokémon GO': 'Pokémon-GO',
    'Power Keepers': 'EX-Power-Keepers',
    'Team Magma vs Team Aqua': 'EX-Team-Magma-vs-Team-Aqua',
    'Unseen Forces': 'EX-Unseen-Forces',
    'EX trainer Kit 2 (Minun)': 'EX-Trainer-Kit-2-Minun',
    'EX trainer Kit 2 (Plusle)': 'EX-Trainer-Kit-2-Plusle',
  };
}

export async function build(db) {
  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: targets } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.name AS set_name,
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

  const details = [];
  const counts = {
    targets: targets.length,
    withTcgdexId: 0,
    scrydexFetched: 0,
    scrydex404: 0,
    scrydexErrors: 0,
    noCardmarketIdInScrydex: 0,
    oneCardmarketIdInScrydex: 0,
    multipleCardmarketIdsInScrydex: 0,
    idPresentInOfficialCatalogue: 0,
    nameValidated: 0,
    safeCrosswalks: 0,
    safeCrosswalksPriceable: 0,
  };

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const url = reviewedCardmarketUrl({
      setName: target.set_name,
      name: target.name,
      collectorNumber: target.collector_number,
      variantCode: target.variant_code,
    }, setSlugOverrides());
    if (!target.tcgdex_id) {
      details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'TCGDEX_ID_MISSING' });
      continue;
    }
    counts.withTcgdexId += 1;
    let acquired;
    try {
      acquired = await fetchScrydexCard(target.tcgdex_id);
    } catch (error) {
      counts.scrydexErrors += 1;
      details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'SCRYDEX_ERROR', error: error instanceof Error ? error.message : String(error) });
      if (index + 1 < targets.length) await sleep(PACE_MS);
      continue;
    }
    if (acquired.status === 404) {
      counts.scrydex404 += 1;
      details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'SCRYDEX_404' });
      if (index + 1 < targets.length) await sleep(PACE_MS);
      continue;
    }
    counts.scrydexFetched += 1;
    const ids = productIdsFromScrydex(acquired.payload);
    if (ids.length === 0) {
      counts.noCardmarketIdInScrydex += 1;
      details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'NO_CARDMARKET_ID_IN_SCRYDEX' });
    } else if (ids.length > 1) {
      counts.multipleCardmarketIdsInScrydex += 1;
      details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'MULTIPLE_CARDMARKET_IDS_IN_SCRYDEX', candidateIds: ids });
    } else {
      counts.oneCardmarketIdInScrydex += 1;
      const sourceRecordId = ids[0];
      const product = productById.get(sourceRecordId);
      if (!product) {
        details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'SCRYDEX_ID_NOT_IN_OFFICIAL_CARDMARKET_CATALOGUE', sourceRecordId });
      } else {
        counts.idPresentInOfficialCatalogue += 1;
        if (!rootProductNameMatches(target.name, product.name)) {
          details.push({ ...target, reviewedCardmarketUrl: url, status: 'held', reason: 'CARDMARKET_PRODUCT_NAME_MISMATCH', sourceRecordId, productName: product.name });
        } else {
          counts.nameValidated += 1;
          const lane = targetLane(target.variant_code);
          const priceable = Boolean(priceById.get(sourceRecordId) && hasMeaningfulCardmarketLane(priceById.get(sourceRecordId), lane));
          counts.safeCrosswalks += 1;
          if (priceable) counts.safeCrosswalksPriceable += 1;
          details.push({ ...target, reviewedCardmarketUrl: url, status: 'safe_crosswalk', sourceRecordId, productName: product.name, lane, priceable });
        }
      }
    }
    if (index + 1 < targets.length) await sleep(PACE_MS);
  }

  const sourceOwners = new Map();
  const collisions = new Set();
  for (const row of details.filter((row) => row.status === 'safe_crosswalk')) {
    const key = `${row.sourceRecordId}|${row.variant_code === 'holo' ? 'holo' : 'normal'}`;
    const prior = sourceOwners.get(key);
    if (prior && prior !== row.id) collisions.add(key);
    else sourceOwners.set(key, row.id);
  }
  const safe = details.filter((row) => row.status === 'safe_crosswalk' && !collisions.has(`${row.sourceRecordId}|${row.variant_code === 'holo' ? 'holo' : 'normal'}`));
  const collisionRows = details.filter((row) => row.status === 'safe_crosswalk' && collisions.has(`${row.sourceRecordId}|${row.variant_code === 'holo' ? 'holo' : 'normal'}`));
  counts.sourceCollisionKeys = collisions.size;
  counts.sourceCollisionRows = collisionRows.length;
  counts.safeAfterCollisionCheck = safe.length;
  counts.safeAfterCollisionCheckPriceable = safe.filter((row) => row.priceable).length;

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      identity: 'reviewed Cardmarket direct URL from set + name + collector/promo number',
      crosswalkHelper: 'Scrydex exact TCGdex card lookup',
      priceProvider: 'Cardmarket public price guide',
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    },
    counts,
    collisionKeys: [...collisions].sort(),
    safeCrosswalks: safe,
    collisionRows,
    held: details.filter((row) => row.status !== 'safe_crosswalk'),
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
  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-url-first-scrydex-crosswalk.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, counts: report.counts, source: report.source }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
