import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const REVIEWED_POKEMONTCG_FINISH_RECOVERY_SOURCE = Object.freeze({
  auditRunId: 34719433407,
  artifactId: 10306019852,
  artifactZipSha256: 'a6e07a039e0989afc2c87d14873659947e19756bf91768f90d7c0f26518938b0',
  tcgdexRevision: '5b6a2859f454972477a9953ffe5cb554d24c45e9',
  cardmarketCatalogueSha256: '3073b2b505f384c5543365ebba11e24ad3e836dfb6dd75465de01ea133472ab3',
  cardmarketPriceGuideSha256: 'fb81140010665760e01861e3028aa173e9d2b645f06b3feb20a674d1cd426764',
  pokemonTcgEvidenceSha256: '5be68733a889b743951d9c624ea0976f37d57aa7c14ace7fbc3b1d602f00e9fa',
  candidateDigest: '2e80a4d2dba6d76db242b0437e7961a5778856456d59dc4b2647eab9f34a7f5c',
});

export const REVIEWED_UMBREON_SIBLING_SOURCE = Object.freeze({
  runId: 34717195189,
  artifactId: 10304941238,
  artifactZipSha256: '81c9306b5cb38cf53695fd75d3bfff67b853f168f7876a99856548602eacc59b',
  bundleDigest: '7ef2c1d7c159fa33b634867add6357363cb8bdfbef1bd515524bb04348af1d0d',
});

const evidenceUrl = new URL('../../../evidence/pokemontcg-finish-evidence-audit-34719433407.json', import.meta.url);
const umbreonEvidenceUrl = new URL('../../../evidence/english-pricing-bundle-34717195189-reviewed-mapping.json', import.meta.url);

function candidateLine(row) {
  return [
    row.id,
    row.cardIdentityId,
    row.variantCode,
    row.tcgdexCardId,
    String(row.sourceRecordId),
    row.sourceVariantKey,
    row.providerPriceGuideLane,
  ].join('|');
}

export function loadReviewedPokemonTcgFinishRecovery() {
  const report = JSON.parse(readFileSync(evidenceUrl, 'utf8'));
  const candidates = Array.isArray(report.candidates) ? report.candidates : [];
  if (report.status !== 'audit_complete' || report.productionWrites !== false || report.activationAuthorized !== false) {
    throw new Error('Frozen PokemonTCG finish evidence is not a read-only completed audit');
  }
  if (report.counts?.safeExactMappings !== 410 || report.byVariant?.standard !== 359 || report.byVariant?.holo !== 51) {
    throw new Error('Frozen PokemonTCG finish evidence counts drifted');
  }
  if (report.source?.tcgdexRevision !== REVIEWED_POKEMONTCG_FINISH_RECOVERY_SOURCE.tcgdexRevision
    || report.source?.cardmarketCatalogueSha256 !== REVIEWED_POKEMONTCG_FINISH_RECOVERY_SOURCE.cardmarketCatalogueSha256
    || report.source?.cardmarketPriceGuideSha256 !== REVIEWED_POKEMONTCG_FINISH_RECOVERY_SOURCE.cardmarketPriceGuideSha256
    || report.source?.pokemonTcg?.sha256 !== REVIEWED_POKEMONTCG_FINISH_RECOVERY_SOURCE.pokemonTcgEvidenceSha256) {
    throw new Error('Frozen PokemonTCG finish evidence source fingerprint drifted');
  }
  if (candidates.length !== 410) throw new Error('Frozen PokemonTCG finish candidate count drifted');
  if (new Set(candidates.map((row) => row.cardIdentityId)).size !== 410) throw new Error('Duplicate canonical identities in reviewed finish cohort');
  if (new Set(candidates.map((row) => `${row.sourceRecordId}|${row.sourceVariantKey}`)).size !== 410) throw new Error('Duplicate Cardmarket source keys in reviewed finish cohort');
  if (candidates.some((row) => !['standard', 'holo'].includes(row.variantCode))) throw new Error('Unsupported finish in reviewed finish cohort');
  if (candidates.some((row) => row.sourceVariantKey !== (row.variantCode === 'standard' ? 'normal' : 'holo'))) throw new Error('Source finish mismatch in reviewed finish cohort');
  if (candidates.some((row) => row.proof?.externalFinishKey !== (row.variantCode === 'standard' ? 'normal' : 'holofoil'))) throw new Error('External finish proof mismatch in reviewed finish cohort');
  const digest = createHash('sha256').update([...candidates]
    .sort((a, b) => a.cardIdentityId.localeCompare(b.cardIdentityId)
      || String(a.sourceRecordId).localeCompare(String(b.sourceRecordId))
      || a.sourceVariantKey.localeCompare(b.sourceVariantKey))
    .map(candidateLine).join('\n')).digest('hex');
  if (digest !== REVIEWED_POKEMONTCG_FINISH_RECOVERY_SOURCE.candidateDigest) throw new Error('Frozen PokemonTCG finish candidate digest drifted');
  return Object.freeze({ report, candidates: Object.freeze(candidates.map((row) => Object.freeze(row))) });
}

export function loadReviewedUmbreonSiblingRecovery() {
  const evidence = JSON.parse(readFileSync(umbreonEvidenceUrl, 'utf8'));
  const row = evidence.candidate;
  if (evidence.source?.runId !== REVIEWED_UMBREON_SIBLING_SOURCE.runId
    || evidence.source?.artifactId !== REVIEWED_UMBREON_SIBLING_SOURCE.artifactId
    || evidence.source?.artifactZipSha256 !== REVIEWED_UMBREON_SIBLING_SOURCE.artifactZipSha256
    || evidence.source?.bundleDigest !== REVIEWED_UMBREON_SIBLING_SOURCE.bundleDigest) {
    throw new Error('Frozen Umbreon sibling evidence source drifted');
  }
  if (evidence.classification?.outcome !== 'mapping_candidate_with_price'
    || evidence.classification?.cardIdentityId !== 'fdcard_043a2f0fc48bc2f9afaf7be5'
    || evidence.classification?.variant !== 'standard'
    || evidence.classification?.collectorNumber !== 'swsh129') {
    throw new Error('Frozen Umbreon classification drifted');
  }
  if (!row
    || row.id !== 'fdcardmap_37b5617121cc48a802b034cb'
    || row.cardIdentityId !== 'fdcard_043a2f0fc48bc2f9afaf7be5'
    || row.variantCode !== 'standard'
    || row.cardName !== 'Umbreon'
    || row.collectorNumber !== 'swsh129'
    || row.tcgdexCardId !== 'swshp-SWSH129'
    || String(row.sourceRecordId) !== '568801'
    || row.sourceVariantKey !== 'normal'
    || row.providerPriceGuideLane !== 'standard'
    || row.proof?.method !== 'same_printing_single_exact_cardmarket_product_with_meaningful_target_finish_lane'
    || !Array.isArray(row.proof?.siblingEvidence)
    || row.proof.siblingEvidence.length !== 1
    || row.proof.siblingEvidence[0].cardIdentityId !== 'fdcard_3c5841311477627da2c18e7d'
    || row.proof.siblingEvidence[0].variantCode !== 'holo'
    || row.proof.siblingEvidence[0].sourceVariantKey !== 'holo') {
    throw new Error('Frozen Umbreon sibling mapping evidence drifted');
  }
  return Object.freeze({
    evidence,
    candidate: Object.freeze({
      ...row,
      name: row.cardName,
      proof: Object.freeze({ ...row.proof, cardmarketLaneBasis: 'direct_cardmarket_finish_lane' }),
    }),
  });
}

export function loadReviewedCombinedCardmarketRecovery() {
  const external = loadReviewedPokemonTcgFinishRecovery();
  const sibling = loadReviewedUmbreonSiblingRecovery();
  const candidates = [...external.candidates, sibling.candidate];
  if (candidates.length !== 411) throw new Error('Combined reviewed Cardmarket recovery count drifted');
  if (new Set(candidates.map((row) => row.cardIdentityId)).size !== 411) throw new Error('Combined reviewed identity collision');
  if (new Set(candidates.map((row) => `${row.sourceRecordId}|${row.sourceVariantKey}`)).size !== 411) throw new Error('Combined reviewed source-finish collision');
  return Object.freeze({ external, sibling, candidates: Object.freeze(candidates) });
}

export const REVIEWED_POKEMONTCG_INHERENT_HOLO_PRODUCT_IDS = Object.freeze(['687429']);
const inherentIds = new Set(REVIEWED_POKEMONTCG_INHERENT_HOLO_PRODUCT_IDS);
export const isReviewedPokemonTcgInherentHoloProduct = (id) => inherentIds.has(String(id));

export const REVIEWED_POKEMONTCG_INHERENT_HOLO_MAPPING_DIGEST = 'eb04494accf9022bb439d0857fa94e0cb58e82ff04901970957e1329491d6095';

export function validateReviewedPokemonTcgInherentHoloMappings(rows) {
  const scoped = (rows || []).filter((row) => String(row.source_record_id) === '687429' && row.source_variant_key === 'holo');
  if (scoped.length !== 1) return new Set();
  const row = scoped[0];
  if (row.canonical_variant_code !== 'holo' || row.language_code !== 'en' || row.verification_status !== 'verified') return new Set();
  const line = [row.id, row.card_identity_id, String(row.source_record_id), row.source_variant_key, row.canonical_variant_code, row.language_code, row.verification_status].join('|');
  return createHash('sha256').update(line).digest('hex') === REVIEWED_POKEMONTCG_INHERENT_HOLO_MAPPING_DIGEST
    ? new Set(REVIEWED_POKEMONTCG_INHERENT_HOLO_PRODUCT_IDS)
    : new Set();
}
