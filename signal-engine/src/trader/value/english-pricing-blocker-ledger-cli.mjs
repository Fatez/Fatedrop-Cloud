import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { build as mappingAudit } from './cardmarket-approved-residual-recovery-cli.mjs';
import { build as holoAudit } from './cardmarket-residual-holo-evidence-audit-cli.mjs';
import { build as priceAudit } from './cardmarket-residual-price-audit-cli.mjs';
import { fetchCardmarketPokemonPriceGuide, fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

export function reconcileLedger(mapping, pricing, eligibleIds) {
  const eligible = new Set(eligibleIds);
  const candidates = new Map(mapping.candidates.map(r => [r.cardIdentityId, r]));
  const collisions = new Set(mapping.collisionRows.map(r => r.cardIdentityId));
  const rows = mapping.resolutions.map(r => {
    const id = r.identity.cardIdentityId;
    const candidate = candidates.get(id);
    return { ...r.identity, section: 'unmapped', reason: collisions.has(id) ? 'HOLD_BATCH_SOURCE_COLLISION' : candidate ? 'REVIEWED_MAPPING_CANDIDATE' : r.status,
      evidence: r, candidate: candidate || null };
  });
  for (const row of pricing.rows) {
    if (!eligible.has(row.cardIdentityId)) continue;
    // The older diagnostic accepts low-only prices. Do not count those as central prices.
    const p = row.currentProviderRow;
    const fields = row.variantCode === 'holo' ? ['trendHolo','avg1Holo','avg7Holo','avg30Holo'] : ['trend','avg1','avg7','avg30'];
    const central = p && fields.some(k => Number.isFinite(Number(p[k])) && Number(p[k]) > 0);
    rows.push({ ...row, section: 'mapped_unpriced',
      reason: row.classification === 'current_target_lane_priceable' && !central ? 'NO_SUPPORTED_CENTRAL_PRICE' : row.classification });
  }
  const seen = new Set();
  for (const row of rows) {
    if (!eligible.has(row.cardIdentityId) || seen.has(row.cardIdentityId)) throw new Error('Ledger contains duplicate or out-of-scope identity');
    if (row.reason === 'PRE_BATCH_SAFE') throw new Error('Unfinalised candidate in ledger');
    seen.add(row.cardIdentityId);
  }
  if (seen.size !== eligible.size) throw new Error('Ledger does not cover every eligible unpriced identity');
  const groups = new Map();
  for (const row of rows) {
    const k = JSON.stringify([row.section,row.setId,row.variantCode,row.reason]);
    const group = groups.get(k) || { section: row.section, setId: row.setId, setName: row.setName, finish: row.variantCode, reason: row.reason, count: 0 };
    group.count++; groups.set(k,group);
  }
  return { status: 'audit_complete', productionWrites: false,
    counts: { total: rows.length, unmapped: rows.filter(r=>r.section==='unmapped').length,
      mappedUnpriced: rows.filter(r=>r.section==='mapped_unpriced').length,
      mappingCandidates: candidates.size, priceableMappingCandidates: [...candidates.values()].filter(r=>r.priceableNow).length },
    groups: [...groups.values()].sort((a,b)=>b.count-a.count || a.setName.localeCompare(b.setName)),
    rows };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const sources = { guide: await fetchCardmarketPokemonPriceGuide(), catalogue: await fetchCardmarketPokemonSinglesCatalogue() };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await db.query(`
      SELECT i.id FROM fatedrop_card_identities i
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND greatest(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
      ORDER BY i.id`);
    const mapping = await mappingAudit(db,{ sources });
    const pricing = await priceAudit(db,{ sources });
    const report = reconcileLedger(mapping,pricing,rows.map(r=>r.id));
    report.source = mapping.source;
    const holo = await holoAudit(db,{ sources });
    const eligible = new Set(rows.map(r=>r.id));
    report.holoEvidence = holo.rows.filter(r=>eligible.has(r.cardIdentityId));
    await db.query('COMMIT');
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/english-pricing-blocker-ledger.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({ status:report.status,productionWrites:false,counts:report.counts,groups:report.groups, holoEvidence:report.holoEvidence },null,2));
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); await pool.end(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
