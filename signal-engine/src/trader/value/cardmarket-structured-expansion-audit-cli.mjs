import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { rankCardmarketExpansionEvidence } from './cardmarket-mapping-audit.mjs';
import {
  build as buildBase,
  buildStructuredProductIndex,
  resolveStructuredIdentity,
} from './cardmarket-structured-identity-recovery-cli.mjs';

function key(...parts) { return parts.join('|'); }

function proveExpansion(ranked) {
  if (!ranked.length) return { status: 'HOLD_SET_SCOPE_NO_EVIDENCE' };
  const top = ranked[0];
  const requiredOverlap = Math.min(20, Math.max(5, Math.ceil(Number(top.canonicalDistinctPrintingKeyCount || 0) * 0.25)));
  if (top.exactPrintingKeyOverlap < requiredOverlap || top.canonicalExactPrintingCoverage < 0.90 || top.sourceExactPrintingPrecision < 0.80) {
    return { status: 'HOLD_SET_SCOPE_BELOW_PROOF', top };
  }
  const second = ranked[1] || null;
  if (second
      && second.canonicalExactPrintingCoverage >= top.canonicalExactPrintingCoverage - 0.03
      && second.sourceExactPrintingPrecision >= top.sourceExactPrintingPrecision - 0.08
      && second.exactPrintingKeyOverlap >= Math.floor(top.exactPrintingKeyOverlap * 0.90)) {
    return { status: 'HOLD_SET_SCOPE_AMBIGUOUS', top, second };
  }
  return { status: 'PROVEN_SET_SCOPE', sourceExpansionId: top.sourceExpansionId, top, second };
}

export async function buildExpandedAudit(db) {
  const [catalogue, guide] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const base = await buildBase(db, { sources: { catalogue, guide } });
  const missing = base.resolutions.filter((row) => row.status === 'HOLD_SET_MAPPING_MISSING');
  const missingSetIds = [...new Set(missing.map((row) => row.identity.setId))];

  const { rows: printingRows } = missingSetIds.length ? await db.query(`
    SELECT DISTINCT i.set_id,p.id,p.name,p.collector_number
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.set_id=ANY($1::text[])
      AND i.verification_status='verified'
      AND i.language_code='en'
    ORDER BY i.set_id,p.collector_number,p.name`, [missingSetIds]) : { rows: [] };

  const cardsBySet = new Map();
  for (const row of printingRows) {
    const rows = cardsBySet.get(row.set_id) || [];
    rows.push({ fateCardId: row.id, printingId: row.id, name: row.name, collectorNumber: row.collector_number, verificationStatus: 'verified' });
    cardsBySet.set(row.set_id, rows);
  }

  const setProofs = new Map();
  for (const setId of missingSetIds) {
    const cards = cardsBySet.get(setId) || [];
    let proof;
    try { proof = proveExpansion(rankCardmarketExpansionEvidence(catalogue.products, cards, { limit: 5 })); }
    catch (error) { proof = { status: 'HOLD_SET_SCOPE_ERROR', error: error instanceof Error ? error.message : String(error) }; }
    setProofs.set(setId, proof);
  }

  const { rows: existingMappings } = await db.query(`SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const sourceOwners = new Map(existingMappings.map((row) => [key(row.source_record_id,row.source_variant_key),row.card_identity_id]));
  const productIndex = buildStructuredProductIndex(catalogue.products);
  const priceByProduct = new Map(guide.snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const replacements = new Map();
  for (const row of missing) {
    const proof = setProofs.get(row.identity.setId);
    if (proof?.status !== 'PROVEN_SET_SCOPE') {
      replacements.set(row.identity.cardIdentityId, { identity: row.identity, status: proof?.status || 'HOLD_SET_SCOPE_NO_EVIDENCE', setScopeProof: proof || null, candidates: [] });
      continue;
    }
    const identity = { ...row.identity, cardmarketExpansionIds: [String(proof.sourceExpansionId)] };
    replacements.set(row.identity.cardIdentityId, { identity, setScopeProof: proof, ...resolveStructuredIdentity(identity, { productIndex, priceByProduct, sourceOwners }) });
  }

  const resolutions = base.resolutions.map((row) => replacements.get(row.identity.cardIdentityId) || row);
  const candidates = resolutions.filter((row) => row.status === 'SAFE_MAPPING_CANDIDATE').map((row) => ({ ...row.candidate, setScopeProof: row.setScopeProof || null }));
  const reasons = resolutions.reduce((out,row) => (out[row.status]=(out[row.status]||0)+1,out),{});

  return {
    status: 'audit_complete', productionWrites: false,
    source: base.source,
    counts: {
      sectionB: base.counts.sectionB,
      safeExactMappings: candidates.length,
      held: base.counts.sectionB - candidates.length,
      setScopesProven: [...setProofs.values()].filter((row) => row.status === 'PROVEN_SET_SCOPE').length,
      setScopesHeld: [...setProofs.values()].filter((row) => row.status !== 'PROVEN_SET_SCOPE').length,
    },
    reasons, candidates, resolutions, setProofs: Object.fromEntries(setProofs),
  };
}

validateProductionTarget(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = await pool.connect();
let report;
try {
  report = await buildExpandedAudit(db);
  const expected = Number(process.env.EXPECTED_SECTION_B || 0);
  if (expected > 0 && report.counts.sectionB !== expected) throw new Error(`Section B drift: expected ${expected}, found ${report.counts.sectionB}`);
} catch (error) {
  report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-structured-expansion-audit.json`, JSON.stringify(report,null,2));
console.log(JSON.stringify({ status: report.status, counts: report.counts, reasons: report.reasons },null,2));
