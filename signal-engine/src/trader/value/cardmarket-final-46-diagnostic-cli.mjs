import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

import { normaliseCollectorNumber } from '../card-identity.mjs';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import {
  distinctExplicitCardmarketProductIds,
  hasSupportedCentralCardmarketLane,
  providerDescriptorIsUniqueSubset,
  providerDescriptorTerms,
  tcgdexDescriptorEvidence,
} from './cardmarket-approved-residual-recovery-cli.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-final-46-user-urls-2026-09-15.json');
const DP_EVIDENCE_PATH = path.resolve('evidence/dp-promos-cardmarket-expansion-evidence-2026-09-14.json');
const EXPECTED = 46;
const finishPolicy = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});

function collector(value) {
  return normaliseCollectorNumber(String(value ?? '').trim());
}

function key(...parts) {
  return parts.map((part) => String(part ?? '')).join('|');
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function loadDpExpansion(products) {
  const evidence = JSON.parse(await readFile(DP_EVIDENCE_PATH, 'utf8'));
  if (evidence?.schemaVersion !== 1 || evidence?.setName !== 'DP Black Star Promos' || evidence?.tcgdexSetId !== 'dpp') {
    throw new Error('DP promo expansion evidence drift');
  }
  if (evidence?.pinnedTcgdexRevision !== process.env.TCGDEX_REVISION) {
    throw new Error('DP promo pinned TCGdex revision drift');
  }
  const anchorId = String(evidence?.anchor?.cardmarketProductId || '');
  const anchor = products.find((product) => String(product.sourceRecordId) === anchorId);
  const expansionId = positiveInteger(anchor?.sourceExpansionId);
  if (!anchorId || !anchor || !expansionId || !rootProductNameMatches(evidence.anchor.cardName, anchor.name)) {
    throw new Error('DP promo anchor no longer proves one Cardmarket expansion');
  }
  return Object.freeze({ expansionId, anchorId, evidence });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const manifest = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (manifest.entries?.length !== EXPECTED) throw new Error(`Expected ${EXPECTED} reviewed entries`);
  if (manifest.policy?.priceProvider !== 'cardmarket-public-download' || manifest.policy?.webPagePriceScraping !== false) {
    throw new Error('Final-46 provider policy drift');
  }

  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  const setByCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) {
    cardById.set(card.tcgdexCardId, card);
    setByCardId.set(card.tcgdexCardId, set);
  }

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const productsByExpansion = new Map();
  for (const product of products) {
    const expansionId = positiveInteger(product.sourceExpansionId);
    if (!expansionId) continue;
    const rows = productsByExpansion.get(expansionId) || [];
    rows.push(product);
    productsByExpansion.set(expansionId, rows);
  }
  const dpExpansion = await loadDpExpansion(products);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const ids = manifest.entries.map((row) => row.cardIdentityId);
    const { rows } = await db.query(`
      SELECT i.id,i.set_id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
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
      GROUP BY i.id,i.set_id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
               s.name,rs.classifier_state`, [ids]);
    const canonicalById = new Map(rows.map((row) => [row.id, row]));

    const { rows: owners } = await db.query(`
      SELECT card_identity_id,source_record_id,source_variant_key
      FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
    const sourceOwners = new Map();
    const identityOwners = new Map();
    for (const row of owners) {
      const sourceKey = key(row.source_record_id, row.source_variant_key);
      const sourceRows = sourceOwners.get(sourceKey) || [];
      sourceRows.push(row);
      sourceOwners.set(sourceKey, sourceRows);
      const identityRows = identityOwners.get(row.card_identity_id) || [];
      identityRows.push(row);
      identityOwners.set(row.card_identity_id, identityRows);
    }

    const targetSetIds = [...new Set(rows.map((row) => row.set_id))];
    const { rows: setMappings } = await db.query(`
      SELECT set_id,source_record_id FROM fatedrop_card_set_source_mappings
      WHERE source_name='cardmarket' AND set_id=ANY($1::text[])
      ORDER BY set_id,source_record_id`, [targetSetIds]);
    const setOverrides = new Map();
    for (const row of setMappings) {
      const values = setOverrides.get(row.set_id) || [];
      if (!values.includes(String(row.source_record_id))) values.push(String(row.source_record_id));
      setOverrides.set(row.set_id, values);
    }

    const preflight = [];
    const preflightById = new Map();
    for (const entry of manifest.entries) {
      const canonical = canonicalById.get(entry.cardIdentityId);
      if (!canonical || !Array.isArray(canonical.tcgdex_card_ids) || canonical.tcgdex_card_ids.length !== 1) continue;
      const tcgdexCardId = canonical.tcgdex_card_ids[0];
      const card = cardById.get(tcgdexCardId);
      const set = setByCardId.get(tcgdexCardId);
      if (!card || !set) continue;
      const explicitIds = [...new Set([
        ...distinctExplicitCardmarketProductIds(card),
        getRootCardmarketProductId(card),
      ].map(positiveInteger).filter(Boolean))].map(String).sort((a, b) => Number(a) - Number(b));
      const row = { entry, canonical, tcgdexCardId, card, set, explicitIds };
      preflight.push(row);
      preflightById.set(entry.cardIdentityId, row);
    }

    // Some legacy promo TCGdex rows intentionally/recurrently share one provider ID
    // across different collector numbers. That is useful corroboration, not identity
    // proof. Never release a shared explicit source key; fall through to expansion
    // + unique name/descriptor evidence instead.
    const explicitOwners = new Map();
    for (const row of preflight) {
      const policy = finishPolicy[row.entry.variantCode];
      if (!policy || row.explicitIds.length !== 1) continue;
      const sourceKey = key(row.explicitIds[0], policy.sourceVariantKey);
      const values = explicitOwners.get(sourceKey) || new Set();
      values.add(row.entry.cardIdentityId);
      explicitOwners.set(sourceKey, values);
    }
    const sharedExplicitKeys = new Set([...explicitOwners.entries()].filter(([, values]) => values.size > 1).map(([sourceKey]) => sourceKey));

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
      const card = cardById.get(tcgdexCardId);
      const set = setByCardId.get(tcgdexCardId);
      if (!card || !set) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, tcgdexCardId, reason: 'PINNED_TCGDEX_CARD_MISSING' });
        continue;
      }
      if (!rootProductNameMatches(entry.name, card.name) || collector(entry.collectorNumber) !== collector(card.localId)) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, tcgdexCardId, reason: 'PINNED_TCGDEX_IDENTITY_DRIFT' });
        continue;
      }

      const policy = finishPolicy[entry.variantCode];
      if (!policy) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'UNSUPPORTED_FINISH' });
        continue;
      }

      const overrides = setOverrides.get(canonical.set_id) || [];
      const tcgdexExpansion = positiveInteger(set.cardmarketExpansionId);
      let expansionId = null;
      let expansionBasis = null;
      if (overrides.length > 1) {
        ambiguous.push({ cardIdentityId: entry.cardIdentityId, reason: 'MULTIPLE_CARDMARKET_SET_OVERRIDES', overrides });
        continue;
      }
      if (overrides.length === 1) {
        const override = positiveInteger(overrides[0]);
        if (!override) {
          unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'INVALID_CARDMARKET_SET_OVERRIDE' });
          continue;
        }
        if (tcgdexExpansion && tcgdexExpansion !== override) {
          ambiguous.push({ cardIdentityId: entry.cardIdentityId, reason: 'SET_EXPANSION_EVIDENCE_CONFLICT', override, tcgdexExpansion });
          continue;
        }
        expansionId = override;
        expansionBasis = 'fatedrop_cardmarket_set_mapping';
      } else if (tcgdexExpansion) {
        expansionId = tcgdexExpansion;
        expansionBasis = 'pinned_tcgdex_cardmarket_expansion';
      } else if (set.tcgdexSetId === 'dpp') {
        expansionId = dpExpansion.expansionId;
        expansionBasis = 'merged_dp_promo_anchor_evidence';
      }
      if (!expansionId) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, tcgdexCardId, reason: 'NO_EXPLICIT_CARDMARKET_EXPANSION' });
        continue;
      }

      const pre = preflightById.get(entry.cardIdentityId);
      const explicitIds = pre?.explicitIds || [];
      let product = null;
      let proof = null;
      if (explicitIds.length === 1) {
        const sourceRecordId = explicitIds[0];
        const sourceKey = key(sourceRecordId, policy.sourceVariantKey);
        const explicitProduct = productById.get(sourceRecordId);
        if (!sharedExplicitKeys.has(sourceKey)
          && explicitProduct
          && Number(explicitProduct.sourceExpansionId) === expansionId
          && rootProductNameMatches(entry.name, explicitProduct.name)) {
          product = explicitProduct;
          proof = {
            method: 'pinned_tcgdex_unique_cardmarket_product_id_locked_fatedrop_finish',
            explicitProductIds: explicitIds,
          };
        }
      }

      const sameName = (productsByExpansion.get(expansionId) || []).filter((candidate) => rootProductNameMatches(entry.name, candidate.name));
      const descriptors = tcgdexDescriptorEvidence(card);
      if (!product && sameName.length === 1) {
        [product] = sameName;
        proof = {
          method: 'unique_root_name_in_explicit_cardmarket_expansion',
          sameNameCandidateCount: 1,
        };
      }
      if (!product && sameName.length > 1 && descriptors.length) {
        const descriptorMatches = sameName
          .map((candidate) => ({ candidate, terms: providerDescriptorTerms(candidate.name) }))
          .filter(({ terms }) => terms.length > 0 && providerDescriptorIsUniqueSubset(terms, descriptors));
        if (descriptorMatches.length === 1) {
          product = descriptorMatches[0].candidate;
          proof = {
            method: 'unique_provider_descriptor_subset_in_explicit_cardmarket_expansion',
            providerDescriptorTerms: descriptorMatches[0].terms,
            exactTcgdexDescriptors: descriptors,
            sameNameCandidateCount: sameName.length,
          };
        } else if (descriptorMatches.length > 1) {
          ambiguous.push({
            cardIdentityId: entry.cardIdentityId,
            reason: 'MULTIPLE_DESCRIPTOR_MATCHES',
            expansionId,
            explicitIds,
            tcgdexDescriptors: descriptors,
            candidates: descriptorMatches.map(({ candidate, terms }) => ({ sourceRecordId: String(candidate.sourceRecordId), productName: candidate.name, terms })),
          });
          continue;
        }
      }
      if (!product) {
        const reason = sameName.length === 0 ? 'NO_PRODUCT_NAME_MATCH_IN_EXPLICIT_EXPANSION' : 'NO_UNIQUE_PRODUCT_PROOF';
        unresolved.push({
          cardIdentityId: entry.cardIdentityId,
          tcgdexCardId,
          reason,
          expansionId,
          expansionBasis,
          explicitIds,
          sharedExplicit: explicitIds.length === 1 && sharedExplicitKeys.has(key(explicitIds[0], policy.sourceVariantKey)),
          tcgdexDescriptors: descriptors,
          candidates: sameName.map((candidate) => ({
            sourceRecordId: String(candidate.sourceRecordId),
            productName: candidate.name,
            descriptorTerms: providerDescriptorTerms(candidate.name),
          })),
        });
        continue;
      }

      const sourceRecordId = String(product.sourceRecordId);
      if (!hasSupportedCentralCardmarketLane(priceById.get(sourceRecordId), policy.priceLane)) {
        unresolved.push({ cardIdentityId: entry.cardIdentityId, reason: 'NO_SUPPORTED_CENTRAL_PRICE_LANE', sourceRecordId, expansionId });
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
      if ((sourceOwners.get(key(sourceRecordId, policy.sourceVariantKey)) || [])
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
        expansionBasis,
        proof: {
          ...proof,
          reviewedUrl: entry.url,
          reviewedCollectorNumber: entry.collectorNumber,
          canonicalFateDropFinish: entry.variantCode,
          webpagePriceScraping: false,
        },
        existing: current.length === 1,
      });
    }

    const batchOwners = new Map();
    for (const row of resolved) {
      const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
      const values = batchOwners.get(sourceKey) || [];
      values.push(row);
      batchOwners.set(sourceKey, values);
    }
    for (const [sourceKey, values] of batchOwners) {
      if (values.length < 2) continue;
      for (const row of values) {
        resolved.splice(resolved.indexOf(row), 1);
        ambiguous.push({ cardIdentityId: row.cardIdentityId, reason: 'BATCH_SOURCE_COLLISION', sourceKey });
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
        dpPromoAnchorProductId: dpExpansion.anchorId,
        dpPromoExpansionId: dpExpansion.expansionId,
        identityLocatorMethod: 'reviewed_url_plus_pinned_metadata_and_official_public_downloads',
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
