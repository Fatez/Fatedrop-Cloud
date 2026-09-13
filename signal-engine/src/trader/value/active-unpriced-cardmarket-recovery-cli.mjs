import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const EXPECTED_ACTIVE_UNPRICED = 87;
const EXPECTED_CANDIDATES = 23;
const expectedSourceVariant = Object.freeze({ standard: 'normal', holo: 'holo' });
const expectedLane = Object.freeze({ standard: 'standard', holo: 'holo' });

async function validateManifest(db, manifest) {
  if (manifest?.expectedActiveUnpriced !== EXPECTED_ACTIVE_UNPRICED || manifest?.expectedCandidates !== EXPECTED_CANDIDATES) {
    throw new Error('Reviewed recovery manifest count drift');
  }
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length !== EXPECTED_CANDIDATES) {
    throw new Error(`Expected ${EXPECTED_CANDIDATES} reviewed candidates`);
  }
  if (new Set(manifest.candidates.map(row => row.cardIdentityId)).size !== EXPECTED_CANDIDATES) {
    throw new Error('Duplicate canonical identity in reviewed recovery manifest');
  }
  if (new Set(manifest.candidates.map(row => `${row.sourceRecordId}|${row.sourceVariantKey}`)).size !== EXPECTED_CANDIDATES) {
    throw new Error('Duplicate Cardmarket source key in reviewed recovery manifest');
  }

  const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS count FROM fatedrop_variant_resolution_state WHERE classifier_state='ACTIVE_UNPRICED'`);
  if (countRows[0]?.count !== EXPECTED_ACTIVE_UNPRICED) {
    throw new Error(`Expected ${EXPECTED_ACTIVE_UNPRICED} ACTIVE_UNPRICED identities, found ${countRows[0]?.count}`);
  }

  const ids = manifest.candidates.map(row => row.cardIdentityId);
  const { rows } = await db.query(`
    SELECT rs.card_identity_id,rs.classifier_state,i.variant_code,i.language_code,i.verification_status,
           p.name,p.collector_number,array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) AS tcgdex_ids
    FROM fatedrop_variant_resolution_state rs
    JOIN fatedrop_card_identities i ON i.id=rs.card_identity_id
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    WHERE rs.card_identity_id=ANY($1::text[])
    GROUP BY rs.card_identity_id,rs.classifier_state,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number`, [ids]);
  const byId = new Map(rows.map(row => [row.card_identity_id, row]));
  for (const candidate of manifest.candidates) {
    const row = byId.get(candidate.cardIdentityId);
    if (!row || row.classifier_state !== 'ACTIVE_UNPRICED' || row.verification_status !== 'verified' || row.language_code !== 'en') {
      throw new Error(`Canonical state drift for ${candidate.cardIdentityId}`);
    }
    if (row.variant_code !== candidate.variantCode || row.name !== candidate.name || String(row.collector_number) !== String(candidate.collectorNumber)) {
      throw new Error(`Canonical identity drift for ${candidate.cardIdentityId}`);
    }
    if (!Array.isArray(row.tcgdex_ids) || row.tcgdex_ids.length !== 1 || row.tcgdex_ids[0] !== candidate.tcgdexCardId) {
      throw new Error(`TCGdex crosswalk drift for ${candidate.cardIdentityId}`);
    }
    if (expectedSourceVariant[candidate.variantCode] !== candidate.sourceVariantKey) {
      throw new Error(`Finish/source lane mismatch for ${candidate.cardIdentityId}`);
    }
  }
}

async function validateCurrentCardmarket(db, manifest) {
  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(), fetchCardmarketPokemonPriceGuide(),
  ]);
  if (catalogue.sha256 !== manifest.source.cardmarketCatalogueSha256 || guide.sha256 !== manifest.source.cardmarketPriceGuideSha256) {
    throw new Error('Cardmarket source snapshot drift; rerun read-only recovery audit before writing');
  }
  const productById = new Map(products.map(row => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map(row => [String(row.idProduct), row]));
  const validated = [];
  for (const candidate of manifest.candidates) {
    const product = productById.get(String(candidate.sourceRecordId));
    if (!product || product.name !== candidate.cardmarketProductName) {
      throw new Error(`Cardmarket product drift for ${candidate.cardIdentityId}`);
    }
    const lane = expectedLane[candidate.variantCode];
    const guideRow = priceById.get(String(candidate.sourceRecordId));
    if (!guideRow || !hasMeaningfulCardmarketLane(guideRow, lane)) {
      throw new Error(`Current Cardmarket ${lane} lane unavailable for ${candidate.cardIdentityId}`);
    }
    const source = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`, [candidate.sourceRecordId, candidate.sourceVariantKey]);
    if (source.rows[0] && source.rows[0].card_identity_id !== candidate.cardIdentityId) {
      throw new Error(`Cardmarket source ownership conflict for ${candidate.sourceRecordId}/${candidate.sourceVariantKey}`);
    }
    const canonical = await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`, [candidate.cardIdentityId, candidate.sourceVariantKey]);
    if (canonical.rows[0] && String(canonical.rows[0].source_record_id) !== String(candidate.sourceRecordId)) {
      throw new Error(`Canonical Cardmarket ownership conflict for ${candidate.cardIdentityId}`);
    }
    validated.push(candidate);
  }
  return { validated, sourceVersion: catalogue.sha256 };
}

async function persistMappings(db, candidates, sourceVersion) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-active-unpriced-cardmarket-recovery'))`);
    let inserted = 0;
    for (const row of candidates) {
      const state = await db.query(`SELECT classifier_state FROM fatedrop_variant_resolution_state WHERE card_identity_id=$1`, [row.cardIdentityId]);
      if (state.rows[0]?.classifier_state !== 'ACTIVE_UNPRICED') throw new Error(`State changed before write for ${row.cardIdentityId}`);
      const now = Date.now();
      const result = await db.query(`INSERT INTO fatedrop_card_source_mappings
        (id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at)
        VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)
        ON CONFLICT(id) DO NOTHING RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,sourceVersion,now]);
      inserted += result.rowCount;
    }
    await db.query('COMMIT');
    return { insertedMappings: inserted, reviewedCandidates: candidates.length };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error('Usage: node active-unpriced-cardmarket-recovery-cli.mjs manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    await validateManifest(db, manifest);
    const current = await validateCurrentCardmarket(db, manifest);
    report = { status: 'clean', productionWrites: false, priceWrites: false, activeUnpriced: EXPECTED_ACTIVE_UNPRICED, safeExactMappings: current.validated.length };
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persistMappings(db, current.validated, current.sourceVersion);
      report = { ...report, status: 'write_complete', productionWrites: true, persistence };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, priceWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = `${process.env.RUNNER_TEMP || '.'}/active-unpriced-cardmarket-recovery.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

await main();
