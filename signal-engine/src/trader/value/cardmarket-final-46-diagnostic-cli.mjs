import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

import { normaliseCollectorNumber } from '../card-identity.mjs';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-final-46-user-urls-2026-09-15.json');
const EXPECTED = 46;
const CARDMARKET_HOST = 'www.cardmarket.com';
const finishPolicy = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});

function collector(value) {
  return normaliseCollectorNumber(String(value ?? '').trim());
}

function sameLocatorPath(left, right) {
  return decodeURIComponent(left).replace(/\/+$/, '').toLowerCase()
    === decodeURIComponent(right).replace(/\/+$/, '').toLowerCase();
}

async function fetchCanonicalProductPath(productId) {
  let current = new URL(`https://www.cardmarket.com/Pokemon/Products?idProduct=${productId}`);
  for (let hop = 0; hop < 4; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'FateDrop-FateValueLab/1.0 identity-locator-verification',
        },
      });
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get('location');
    if (!location) {
      return { ok: false, reason: `NO_CANONICAL_REDIRECT_HTTP_${response.status}`, path: current.pathname };
    }
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || next.hostname !== CARDMARKET_HOST || next.username || next.password) {
      return { ok: false, reason: 'UNSAFE_CANONICAL_REDIRECT' };
    }
    if (next.pathname.startsWith('/en/Pokemon/Products/Singles/')) {
      return { ok: true, path: next.pathname };
    }
    current = next;
  }
  return { ok: false, reason: 'CANONICAL_REDIRECT_LIMIT' };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const manifest = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (manifest.entries?.length !== EXPECTED) throw new Error(`Expected ${EXPECTED} reviewed entries`);
  if (manifest.policy?.priceProvider !== 'cardmarket-public-download' || manifest.policy?.webPagePriceScraping !== false) {
    throw new Error('Final-46 provider policy drift');
  }

  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const setByCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) setByCardId.set(card.tcgdexCardId, set);

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const productsByExpansion = new Map();
  for (const product of products) {
    const rows = productsByExpansion.get(Number(product.sourceExpansionId)) || [];
    rows.push(product);
    productsByExpansion.set(Number(product.sourceExpansionId), rows);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const ids = manifest.entries.map((row) => row.cardIdentityId);
    const { rows } = await db.query(`
      SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
             s.name AS set_name,rs.classifier_state,
             array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id)
               FILTER (WHERE t.source_record_id IS NOT NULL) AS tcgdex_card_ids
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      LEFT JOIN fatedrop_card_source_mappings t
        ON t.card_identity_id=i.id AND t.source_name='tcgdex'
      WHERE i.id=ANY($1::text[])
      GROUP BY i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
               s.name,rs.classifier_state`, [ids]);
    const canonicalById = new Map(rows.map((row) => [row.id, row]));

    const { rows: owners } = await db.query(`
      SELECT card_identity_id,source_record_id,source_variant_key
      FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
    const sourceOwners = new Map();
    const identityOwners = new Map();
    for (const row of owners) {
      const sourceKey = `${row.source_record_id}|${row.source_variant_key}`;
      const sourceRows = sourceOwners.get(sourceKey) || [];
      sourceRows.push(row);
      sourceOwners.set(sourceKey, sourceRows);
      const identityRows = identityOwners.get(row.card_identity_id) || [];
      identityRows.push(row);
      identityOwners.set(row.card_identity_id, identityRows);
    }

    const redirectCache = new Map();
    const canonicalPath = (id) => {
      const key = String(id);
      if (!redirectCache.has(key)) redirectCache.set(key, fetchCanonicalProductPath(key));
      return redirectCache.get(key);
    };

    const resolved = [];
    const ambiguous = [];
    const unresolved = [];
    for (const entry of manifest.entries) {
      const canonical = canonicalById.get(entry.cardIdentityId);
      let canonicalOk = Boolean(canonical);
      try {
        canonicalOk = canonicalOk
          && canonical.verification_status === 'verified'
          && canonical.language_code === 'en'
          && canonical.variant_code === entry.variantCode
          && canonical.set_name === entry.setName
          && rootProductNameMatches(entry.name, canonical.name)
          && collector(entry.collectorNumber) === collector(canonical.collector_number)
          && !['INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE'].includes(canonical.classifier_state);
      } catch {
        canonicalOk = false;
      }
      if (!canonicalOk) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: canonical ? 'CANONICAL_IDENTITY_DRIFT' : 'CANONICAL_IDENTITY_MISSING' });
        continue;
      }
      if (!Array.isArray(canonical.tcgdex_card_ids) || canonical.tcgdex_card_ids.length !== 1) {
        (canonical.tcgdex_card_ids?.length > 1 ? ambiguous : unresolved).push({
          cardIdentityId: entry.cardIdentityId,
          reason: canonical.tcgdex_card_ids?.length > 1 ? 'MULTIPLE_TCGDEX_LINKS' : 'NO_TCGDEX_LINK',
        });
        continue;
      }
      const tcgdexCardId = canonical.tcgdex_card_ids[0];
      const tcgdexSet = setByCardId.get(tcgdexCardId);
      const expansionId = Number(tcgdexSet?.cardmarketExpansionId);
      if (!Number.isSafeInteger(expansionId) || expansionId <= 0) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, tcgdexCardId, reason: 'NO_EXPLICIT_CARDMARKET_EXPANSION_ID' });
        continue;
      }
      const nameCandidates = (productsByExpansion.get(expansionId) || [])
        .filter((product) => rootProductNameMatches(entry.name, product.name));
      if (!nameCandidates.length) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'NO_OFFICIAL_CATALOGUE_NAME_CANDIDATES', expansionId });
        continue;
      }

      const expectedPath = new URL(entry.url).pathname;
      const checked = await Promise.all(nameCandidates.map(async (product) => ({
        product,
        redirect: await canonicalPath(product.sourceRecordId),
      })));
      const matches = checked.filter((row) => row.redirect.ok && sameLocatorPath(row.redirect.path, expectedPath));
      if (matches.length !== 1) {
        const bucket = matches.length > 1 ? ambiguous : unresolved;
        bucket.push({
          cardIdentityId: entry.cardIdentityId,
          reason: matches.length > 1 ? 'MULTIPLE_EXACT_URL_MATCHES' : 'NO_EXACT_URL_MATCH',
          expansionId,
          candidates: checked.map((row) => ({
            sourceRecordId: String(row.product.sourceRecordId),
            productName: row.product.name,
            canonicalPath: row.redirect.path || null,
            redirectReason: row.redirect.reason || null,
          })),
        });
        continue;
      }

      const product = matches[0].product;
      const sourceRecordId = String(product.sourceRecordId);
      const policy = finishPolicy[entry.variantCode];
      if (!policy || !hasMeaningfulCardmarketLane(priceById.get(sourceRecordId), policy.priceLane)) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'NO_MEANINGFUL_PRICE_LANE', sourceRecordId });
        continue;
      }
      const current = identityOwners.get(entry.cardIdentityId) || [];
      if (current.length > 1
        || (current.length === 1
          && (String(current[0].source_record_id) !== sourceRecordId
            || current[0].source_variant_key !== policy.sourceVariantKey))) {
        ambiguous.push({ cardIdentityId: entry.cardIdentityId, reason: 'IDENTITY_MAPPING_OWNERSHIP_DRIFT' });
        continue;
      }
      if ((sourceOwners.get(`${sourceRecordId}|${policy.sourceVariantKey}`) || [])
        .some((owner) => owner.card_identity_id !== entry.cardIdentityId)) {
        ambiguous.push({ cardIdentityId: entry.cardIdentityId, reason: 'SOURCE_KEY_OWNED_BY_OTHER_IDENTITY', sourceRecordId });
        continue;
      }
      resolved.push({
        cardIdentityId: entry.cardIdentityId,
        tcgdexCardId,
        sourceRecordId,
        sourceVariantKey: policy.sourceVariantKey,
        sourceExpansionId: expansionId,
        cardmarketProductName: product.name,
        proof: 'reviewed_url_exactly_matches_official_idProduct_redirect',
        existing: current.length === 1,
      });
    }

    const batchOwners = new Map();
    for (const row of resolved) {
      const key = `${row.sourceRecordId}|${row.sourceVariantKey}`;
      const rows = batchOwners.get(key) || [];
      rows.push(row);
      batchOwners.set(key, rows);
    }
    for (const [key, rows] of batchOwners) {
      if (rows.length < 2) continue;
      for (const row of rows) {
        resolved.splice(resolved.indexOf(row), 1);
        ambiguous.push({ cardIdentityId: row.cardIdentityId, reason: 'BATCH_SOURCE_COLLISION', sourceKey: key });
      }
    }

    report = {
      status: resolved.length === EXPECTED && ambiguous.length === 0 && unresolved.length === 0 ? 'hard_proof_passed' : 'hard_proof_failed',
      productionWrites: false,
      source: {
        tcgdexRevision: process.env.TCGDEX_REVISION,
        cardmarketCatalogueSha256: catalogueArtifact.sha256,
        cardmarketPriceGuideSha256: guideArtifact.sha256,
        sourceSnapshotId: snapshot.sourceSnapshotId,
        identityLocatorMethod: 'official_cardmarket_idProduct_redirect_metadata',
        webpagePriceScraping: false,
      },
      counts: { reviewed: EXPECTED, resolved: resolved.length, ambiguous: ambiguous.length, unresolved: unresolved.length },
      resolved,
      ambiguous,
      unresolved,
    };
  } finally {
    db.release();
    await pool.end();
  }

  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-final-46-diagnostic.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`FINAL46_HARD_PROOF resolved=${report.counts.resolved}/${EXPECTED} ambiguous=${report.counts.ambiguous} unresolved=${report.counts.unresolved}`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'hard_proof_passed') process.exitCode = 1;
}

await main();
