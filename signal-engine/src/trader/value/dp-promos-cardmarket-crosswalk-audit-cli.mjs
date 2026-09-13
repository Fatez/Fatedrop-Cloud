import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import {
  hasSupportedCentralCardmarketLane,
  providerDescriptorIsUniqueSubset,
  providerDescriptorTerms,
  tcgdexDescriptorEvidence,
} from './cardmarket-approved-residual-recovery-cli.mjs';

const EVIDENCE_PATH = new URL('../../../evidence/dp-promos-cardmarket-expansion-evidence-2026-09-14.json', import.meta.url);
const POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});
const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function collector(value) {
  try { return normaliseCollectorNumber(String(value ?? '')); } catch { return null; }
}

export function reviewedIdentityDigest(rows) {
  const lines = rows
    .map((row) => `${lower(row.name)}|${lower(row.collectorNumber)}|${lower(row.variantCode)}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function exactFinishPresent(card, variantCode) {
  const policy = POLICY[variantCode];
  if (!policy) return false;
  return Array.isArray(card?.variants) && card.variants.some((variant) => variant?.type === policy.tcgdexType);
}

function rootCardmarketProductId(card) {
  if (!card?.sourcePath) return null;
  let source;
  try { source = fs.readFileSync(card.sourcePath, 'utf8'); } catch { return null; }
  const match = /^\tthirdParty\s*:\s*\{\s*(?:\r?\n\s*)?cardmarket\s*:\s*(\d+)/m.exec(source);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function stableMappingId(cardIdentityId, sourceRecordId, sourceVariantKey) {
  const digest = createHash('sha256')
    .update(`${cardIdentityId}|cardmarket|${sourceRecordId}|${sourceVariantKey}`)
    .digest('hex')
    .slice(0, 24);
  return `fdcardmap_${digest}`;
}

async function loadEvidence() {
  const parsed = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (parsed?.schemaVersion !== 1) throw new Error('Unsupported DP promo evidence schema');
  if (parsed?.setName !== 'DP Black Star Promos' || parsed?.tcgdexSetId !== 'dpp') throw new Error('DP promo evidence scope mismatch');
  if (parsed?.policy?.productionWrites !== false) throw new Error('DP promo evidence must be read-only');
  if (parsed?.reviewedUserUrlRows !== 57) throw new Error('DP promo reviewed URL row count drift');
  if (!parsed?.reviewedIdentityDigest || !parsed?.sourceFileSha256) throw new Error('DP promo reviewed evidence hashes are missing');
  return parsed;
}

function sourceOwnerReason(owners, identityId, sourceRecordId, sourceVariantKey) {
  const set = owners.get(key(sourceRecordId, sourceVariantKey));
  if (!set || set.size === 0) return null;
  if (set.size === 1 && set.has(identityId)) return null;
  return 'HOLD_PRODUCT_ALREADY_OWNED';
}

export async function build(db, { repoEvidence, sources, evidence } = {}) {
  const reviewed = evidence || await loadEvidence();
  if (String(process.env.TCGDEX_REVISION || '') !== reviewed.pinnedTcgdexRevision) throw new Error('Pinned TCGdex revision mismatch');
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const set = repo.bySetId.get('dpp');
  if (!set) throw new Error('Pinned TCGdex DP promo set is missing');
  if (set.cardmarketExpansionId != null) throw new Error('Pinned TCGdex DP promo set unexpectedly gained a direct Cardmarket expansion id; review evidence instead of extrapolating');

  const cardById = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));
  const anchorCard = cardById.get(reviewed.anchor.tcgdexCardId);
  if (!anchorCard) throw new Error('Pinned DP promo anchor card is missing');
  if (!rootProductNameMatches(reviewed.anchor.cardName, anchorCard.name)) throw new Error('DP promo anchor card name drift');
  if (collector(reviewed.anchor.collectorNumber) !== collector(anchorCard.localId)) throw new Error('DP promo anchor collector drift');
  const rootAnchorProductId = rootCardmarketProductId(anchorCard);
  if (rootAnchorProductId !== String(reviewed.anchor.cardmarketProductId)) throw new Error('DP promo anchor Cardmarket product link drift');

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const anchorProduct = productById.get(rootAnchorProductId);
  if (!anchorProduct) throw new Error('DP promo anchor product is absent from official Cardmarket catalogue');
  if (!rootProductNameMatches(reviewed.anchor.cardName, anchorProduct.name)) throw new Error('DP promo anchor product name conflicts with pinned evidence');
  const expansionId = Number(anchorProduct.sourceExpansionId);
  if (!Number.isSafeInteger(expansionId) || expansionId <= 0) throw new Error('Official Cardmarket catalogue does not expose an expansion for the DP promo anchor');
  const expansionProducts = products.filter((product) => Number(product.sourceExpansionId) === expansionId);
  if (!expansionProducts.length) throw new Error('DP promo anchor expansion is empty in official Cardmarket catalogue');

  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.id AS set_id,s.name AS set_name,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND s.name='DP Black Star Promos'
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY i.id`);

  const identities = rows.map((row) => Object.freeze({
    cardIdentityId: row.id,
    setId: row.set_id,
    setName: row.set_name,
    name: row.name,
    collectorNumber: row.collector_number,
    variantCode: row.variant_code,
    tcgdexCardIds: row.tcgdex_card_ids,
  }));
  if (identities.length !== reviewed.reviewedUserUrlRows) throw new Error(`DP promo residual cohort drift: expected ${reviewed.reviewedUserUrlRows}, found ${identities.length}`);
  if (reviewedIdentityDigest(identities) !== reviewed.reviewedIdentityDigest) throw new Error('DP promo residual identity digest drift from reviewed user URL evidence');

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existing) {
    const sourceKey = key(row.source_record_id, row.source_variant_key);
    const setOwners = owners.get(sourceKey) || new Set();
    setOwners.add(row.card_identity_id);
    owners.set(sourceKey, setOwners);
  }

  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  const raw = [];
  const resolutions = [];

  for (const identity of identities) {
    const policy = POLICY[identity.variantCode];
    if (!policy) { bump('HOLD_UNSUPPORTED_FINISH'); resolutions.push({ identity, status: 'HOLD_UNSUPPORTED_FINISH' }); continue; }
    if (!Array.isArray(identity.tcgdexCardIds) || identity.tcgdexCardIds.length !== 1) {
      bump('HOLD_TCGDEX_LINK_COUNT'); resolutions.push({ identity, status: 'HOLD_TCGDEX_LINK_COUNT' }); continue;
    }
    const tcgdexCardId = identity.tcgdexCardIds[0];
    const card = cardById.get(tcgdexCardId);
    if (!card) { bump('HOLD_TCGDEX_CARD_MISSING'); resolutions.push({ identity, tcgdexCardId, status: 'HOLD_TCGDEX_CARD_MISSING' }); continue; }
    if (!rootProductNameMatches(identity.name, card.name)) {
      bump('HOLD_TCGDEX_NAME_MISMATCH'); resolutions.push({ identity, tcgdexCardId, status: 'HOLD_TCGDEX_NAME_MISMATCH' }); continue;
    }
    if (collector(identity.collectorNumber) !== collector(card.localId)) {
      bump('HOLD_TCGDEX_COLLECTOR_MISMATCH'); resolutions.push({ identity, tcgdexCardId, status: 'HOLD_TCGDEX_COLLECTOR_MISMATCH' }); continue;
    }
    if (!exactFinishPresent(card, identity.variantCode)) {
      bump('HOLD_TCGDEX_EXACT_FINISH_NOT_EXPLICIT'); resolutions.push({ identity, tcgdexCardId, status: 'HOLD_TCGDEX_EXACT_FINISH_NOT_EXPLICIT' }); continue;
    }

    const sameName = expansionProducts.filter((product) => rootProductNameMatches(identity.name, product.name));
    if (sameName.length === 0) {
      bump('HOLD_NO_PRODUCT_NAME_MATCH_IN_PROVEN_EXPANSION');
      resolutions.push({ identity, tcgdexCardId, status: 'HOLD_NO_PRODUCT_NAME_MATCH_IN_PROVEN_EXPANSION' });
      continue;
    }

    let winner = null;
    let matchMethod = null;
    let descriptorTerms = [];
    let exactTcgdexDescriptors = [];
    if (sameName.length === 1) {
      [winner] = sameName;
      matchMethod = 'unique_root_name_in_anchor_proven_dp_promo_expansion';
    } else {
      exactTcgdexDescriptors = tcgdexDescriptorEvidence(card);
      const descriptorMatches = sameName
        .map((product) => ({ product, terms: providerDescriptorTerms(product.name) }))
        .filter(({ terms }) => terms.length > 0 && providerDescriptorIsUniqueSubset(terms, exactTcgdexDescriptors));
      if (descriptorMatches.length === 0) {
        bump('HOLD_AMBIGUOUS_PRODUCT_NO_UNIQUE_DESCRIPTOR_MATCH');
        resolutions.push({ identity, tcgdexCardId, status: 'HOLD_AMBIGUOUS_PRODUCT_NO_UNIQUE_DESCRIPTOR_MATCH', candidateProductIds: sameName.map((product) => product.sourceRecordId) });
        continue;
      }
      if (descriptorMatches.length > 1) {
        bump('HOLD_MULTIPLE_DESCRIPTOR_MATCHES');
        resolutions.push({ identity, tcgdexCardId, status: 'HOLD_MULTIPLE_DESCRIPTOR_MATCHES', candidateProductIds: descriptorMatches.map(({ product }) => product.sourceRecordId) });
        continue;
      }
      winner = descriptorMatches[0].product;
      descriptorTerms = descriptorMatches[0].terms;
      matchMethod = 'unique_attack_ability_descriptor_match_in_anchor_proven_dp_promo_expansion';
    }

    const sourceRecordId = String(winner.sourceRecordId);
    const ownershipHold = sourceOwnerReason(owners, identity.cardIdentityId, sourceRecordId, policy.sourceVariantKey);
    if (ownershipHold) {
      bump(ownershipHold); resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: ownershipHold }); continue;
    }
    raw.push(Object.freeze({
      id: stableMappingId(identity.cardIdentityId, sourceRecordId, policy.sourceVariantKey),
      cardIdentityId: identity.cardIdentityId,
      setId: identity.setId,
      setName: identity.setName,
      name: identity.name,
      collectorNumber: identity.collectorNumber,
      variantCode: identity.variantCode,
      tcgdexCardId,
      sourceRecordId,
      sourceVariantKey: policy.sourceVariantKey,
      sourceVersion: catalogueArtifact.sha256,
      sourceExpansionId: expansionId,
      cardmarketProductName: winner.name,
      priceLane: policy.priceLane,
      priceableNow: hasSupportedCentralCardmarketLane(priceById.get(sourceRecordId), policy.priceLane),
      proof: Object.freeze({
        method: matchMethod,
        expansionBasis: 'tcgdex_dp20_explicit_product_plus_official_cardmarket_expansion_plus_reviewed_uniform_user_url_slug',
        anchorCardmarketProductId: rootAnchorProductId,
        expansionId,
        reviewedUserUrlFileSha256: reviewed.sourceFileSha256,
        reviewedUserUrlExpansionSlug: reviewed.cardmarketExpansionSlug,
        reviewedUserUrlIdentityDigest: reviewed.reviewedIdentityDigest,
        pinnedTcgdexRevision: reviewed.pinnedTcgdexRevision,
        exactRequestedFinish: identity.variantCode,
        finishProofSource: 'pinned_tcgdex_exact_variant_type',
        providerDescriptorTerms: descriptorTerms,
        exactTcgdexDescriptors,
      }),
    }));
    resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: 'PRE_BATCH_SAFE', method: matchMethod });
  }

  const batchOwners = new Map();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    const ids = batchOwners.get(sourceKey) || new Set();
    ids.add(row.cardIdentityId);
    batchOwners.set(sourceKey, ids);
  }
  const collisionKeys = new Set([...batchOwners.entries()].filter(([, ids]) => ids.size > 1).map(([sourceKey]) => sourceKey));
  const candidates = raw.filter((row) => !collisionKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  const collisionRows = raw.filter((row) => collisionKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  if (collisionRows.length) reasons.HOLD_BATCH_SOURCE_COLLISION = collisionRows.length;
  const priceable = candidates.filter((row) => row.priceableNow);

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      tcgdexRevision: reviewed.pinnedTcgdexRevision,
      userUrlFileSha256: reviewed.sourceFileSha256,
      userUrlDigest: reviewed.reviewedUrlDigest,
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
      anchorProductId: rootAnchorProductId,
      provenCardmarketExpansionId: expansionId,
    }),
    policy: Object.freeze({
      approvedPriceAcquisition: 'cardmarket-public-download',
      setScopeAloneDoesNotProveProduct: true,
      exactPerCardProductRequired: true,
      exactPinnedTcgdexFinishRequired: true,
      cardmarketProductIdAloneDoesNotProveFinish: true,
      userUrlsAreIdentityLocatorsOnly: true,
      noWebPagePriceScraping: true,
      ownershipFailClosed: true,
      batchCollisionsFailClosed: true,
      productionWrites: false,
    }),
    counts: Object.freeze({
      residualDpPromoIdentities: identities.length,
      preBatchSafe: raw.length,
      safeExactMappings: candidates.length,
      supportedCentralPriceNow: priceable.length,
      mappedButNoSupportedCentralPrice: candidates.length - priceable.length,
      held: identities.length - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    }),
    reasons: Object.freeze(reasons),
    candidates: Object.freeze(candidates),
    collisionRows: Object.freeze(collisionRows),
    resolutions: Object.freeze(resolutions),
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
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
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/dp-promos-cardmarket-crosswalk-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
