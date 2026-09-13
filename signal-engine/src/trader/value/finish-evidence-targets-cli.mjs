import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const targetTypeFor = Object.freeze({ standard: 'normal', holo: 'holo', reverse_holo: 'reverse' });
function isBaselineVariant(variant, type) {
  return variant?.type === type && !variant?.subtype && !variant?.foil && Array.isArray(variant?.stamp) && variant.stamp.length === 0;
}

function tcgdexIndex(repositoryRoot) {
  if (!repositoryRoot) return null;
  const repo = loadTcgdexRepositoryEvidence(repositoryRoot, { includeCards: true });
  const byCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) byCardId.set(card.tcgdexCardId, card);
  return { repo, byCardId };
}

export async function buildFinishEvidenceTargets(db, audit, { repositoryRoot = process.env.TCGDEX_REPO } = {}) {
  if (audit?.status !== 'audit_complete' || audit?.productionWrites !== false || !Array.isArray(audit?.held)) {
    throw new Error('Expected the completed frozen read-only finish audit');
  }
  const held = audit.held.filter(row => row.reason === 'external_target_finish_absent');
  const ids = held.map(row => row.cardIdentityId);
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.id=ANY($1::text[])`, [ids]);
  const canonical = new Map(rows.map(row => [row.id, row]));
  const { rows: currentMappings } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket' AND card_identity_id=ANY($1::text[])`, [ids]);
  const currentCardmarket = new Map();
  for (const row of currentMappings) {
    if (!currentCardmarket.has(row.card_identity_id)) currentCardmarket.set(row.card_identity_id, []);
    currentCardmarket.get(row.card_identity_id).push(row);
  }
  const pinned = tcgdexIndex(repositoryRoot);
  const targets = [];
  const blocked = [];
  const enrichment = { pinnedTcgdexCards: 0, exactCardmarketProductIds: 0, existingExactCardmarketMappings: 0, ambiguousCardmarketProductIds: 0 };
  for (const row of held) {
    const current = canonical.get(row.cardIdentityId);
    if (!current) { blocked.push({ cardIdentityId: row.cardIdentityId, reason: 'canonical_identity_missing' }); continue; }
    if (current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) {
      blocked.push({ cardIdentityId: row.cardIdentityId, reason: 'canonical_scope_drift' }); continue;
    }
    const target = {
      cardIdentityId: row.cardIdentityId,
      variantCode: row.variantCode,
      language: 'en',
      edition: 'unspecified',
      name: current.name,
      collectorNumber: current.collector_number,
      tcgdexCardId: row.tcgdexCardId,
      scrydexCardId: row.tcgdexCardId,
      priorExternalFinishKeys: row.externalFinishKeys || [],
      priorExternalRarity: row.externalRarity || null,
    };

    const mapped = (currentCardmarket.get(row.cardIdentityId) || []).filter(mapping => {
      if (row.variantCode === 'standard') return mapping.source_variant_key === 'normal';
      if (row.variantCode === 'holo') return mapping.source_variant_key === 'holo';
      return mapping.source_variant_key === 'reverse_holo';
    });
    if (mapped.length === 1) {
      target.cardmarketProductId = String(mapped[0].source_record_id);
      target.cardmarketCrosswalkBasis = 'existing_exact_canonical_mapping';
      enrichment.existingExactCardmarketMappings += 1;
    }

    const pinnedCard = pinned?.byCardId.get(row.tcgdexCardId);
    if (pinnedCard) {
      enrichment.pinnedTcgdexCards += 1;
      const targetType = targetTypeFor[row.variantCode];
      const baseline = (pinnedCard.variants || []).filter(variant => isBaselineVariant(variant, targetType));
      const productIds = [...new Set(baseline.map(variant => Number(variant.cardmarketProductId)).filter(id => Number.isSafeInteger(id) && id > 0))];
      target.pinnedTcgdexVariantEvidence = baseline.map(variant => ({
        type: variant.type,
        subtype: variant.subtype || null,
        foil: variant.foil || null,
        stamp: variant.stamp || [],
        cardmarketProductId: variant.cardmarketProductId || null,
      }));
      if (productIds.length === 1) {
        if (target.cardmarketProductId && target.cardmarketProductId !== String(productIds[0])) {
          blocked.push({ cardIdentityId: row.cardIdentityId, reason: 'cardmarket_crosswalk_conflict', currentProductId: target.cardmarketProductId, pinnedProductId: String(productIds[0]) });
          continue;
        }
        target.cardmarketProductId = String(productIds[0]);
        target.cardmarketCrosswalkBasis ||= 'pinned_tcgdex_explicit_variant_product_id';
        enrichment.exactCardmarketProductIds += 1;
      } else if (productIds.length > 1) {
        target.cardmarketProductAmbiguity = productIds.map(String).sort();
        enrichment.ambiguousCardmarketProductIds += 1;
      }
    }
    targets.push(target);
  }
  targets.sort((a, b) => a.cardIdentityId.localeCompare(b.cardIdentityId));
  return {
    schemaVersion: 1,
    productionWrites: false,
    sourceScope: 'frozen external_target_finish_absent cohort',
    sourceAuditSha256: audit.source?.pokemonTcg?.sha256 || null,
    tcgdexRevision: process.env.TCGDEX_REVISION || null,
    expectedHistoricalCohort: 1121,
    targetCount: targets.length,
    blockedCount: blocked.length,
    enrichment,
    targets,
    blocked,
  };
}

async function main() {
  const auditPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!auditPath || !outputPath) throw new Error('Usage: node finish-evidence-targets-cli.mjs frozen-audit.json targets.json');
  validateProductionTarget(process.env.DATABASE_URL);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  try {
    const report = await buildFinishEvidenceTargets(db, audit);
    if (report.targetCount + report.blockedCount !== 1121) throw new Error(`Expected historical cohort 1121, found ${report.targetCount + report.blockedCount}`);
    await writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ targetCount: report.targetCount, blockedCount: report.blockedCount, enrichment: report.enrichment, productionWrites: false }));
  } finally {
    db.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
