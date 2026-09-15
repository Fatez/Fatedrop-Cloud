import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { build as buildLegacyPlan } from './cardmarket-full-market-recertification-cli.mjs';

const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification.json');
const STRICT_REPORT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-strict.json');

function sha256(lines) {
  const hash = createHash('sha256');
  for (const line of lines) hash.update(`${line}\n`);
  return hash.digest('hex');
}

function sourceKey(sourceRecordId, sourceVariantKey) {
  return `${String(sourceRecordId)}|${String(sourceVariantKey)}`;
}

function groupBy(rows, keyFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = grouped.get(key) || [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return grouped;
}

function candidateDigest(rows) {
  return sha256(rows.map((row) => [
    row.cardIdentityId,
    row.sourceRecordId,
    row.sourceVariantKey,
    row.reviewedCardmarketUrl,
    row.action,
  ].join('|')).sort());
}

function quarantineFromCandidate(row, reason, details = null) {
  return Object.freeze({
    cardIdentityId: row.cardIdentityId,
    setCode: row.setCode,
    setName: row.setName,
    name: row.name,
    collectorNumber: row.collectorNumber,
    variantCode: row.variantCode,
    classifierState: row.classifierState,
    reason,
    details,
  });
}

function reverseCandidateFromLegacyQuarantine(row) {
  const productId = String(row?.details?.deterministicProductId || '').trim();
  const reviewedUrl = String(row?.details?.reviewedCardmarketUrl || '').trim();
  if (!productId || !reviewedUrl) return null;
  return Object.freeze({
    cardIdentityId: row.cardIdentityId,
    setCode: row.setCode,
    setName: row.setName,
    name: row.name,
    collectorNumber: row.collectorNumber,
    variantCode: row.variantCode,
    classifierState: row.classifierState,
    sourceRecordId: productId,
    sourceVariantKey: 'reverse',
    reviewedCardmarketUrl: reviewedUrl,
    forensicEvidenceUrl: null,
    cardmarketProductName: row.details.cardmarketProductName || null,
    cardmarketExpansionId: String(row.details.expansionId || ''),
    method: 'simple:structured_name_collector:reverse-public-product',
    priceEvidence: Object.freeze({
      standard: false,
      holo: false,
      targetLane: false,
      reverseOfferDerived: true,
    }),
  });
}

function buildStrictIndex(strict) {
  const resolved = new Map();
  const collided = new Set();
  for (const row of [...(strict?.safeMappings || []), ...(strict?.conflicts || [])]) {
    const identityId = row.cardIdentityId;
    if (!identityId) continue;
    const prior = resolved.get(identityId);
    if (prior && String(prior.sourceRecordId) !== String(row.sourceRecordId)) {
      resolved.delete(identityId);
      collided.add(identityId);
      continue;
    }
    if (!collided.has(identityId)) resolved.set(identityId, row);
  }
  for (const row of strict?.rejectedNameMismatch || []) {
    resolved.delete(row.cardIdentityId);
    collided.add(row.cardIdentityId);
  }
  return { resolved, collided };
}

function reverseCandidateFromStrict(row, strictRow) {
  const productId = String(strictRow?.sourceRecordId || '').trim();
  const reviewedUrl = String(strictRow?.reviewedCardmarketUrl || row?.details?.reviewedCardmarketUrl || '').trim();
  if (!productId || !reviewedUrl) return null;
  return Object.freeze({
    cardIdentityId: row.cardIdentityId,
    setCode: row.setCode,
    setName: row.setName,
    name: row.name,
    collectorNumber: row.collectorNumber,
    variantCode: row.variantCode,
    classifierState: row.classifierState,
    sourceRecordId: productId,
    sourceVariantKey: 'reverse',
    reviewedCardmarketUrl: reviewedUrl,
    forensicEvidenceUrl: strictRow?.tcggo?.url || null,
    cardmarketProductName: strictRow?.cardmarketProductName || null,
    cardmarketExpansionId: String(strictRow?.cardmarketExpansionId || ''),
    method: strictRow?.proof?.method
      ? `${strictRow.proof.method}:reverse-public-product`
      : 'forensic:exact_tcgdex_to_cardmarket:reverse-public-product',
    priceEvidence: Object.freeze({
      standard: Boolean(strictRow?.priceEvidence?.standard),
      holo: Boolean(strictRow?.priceEvidence?.holo),
      targetLane: false,
      reverseOfferDerived: true,
    }),
  });
}

async function currentCardmarketMappings(db) {
  const { rows } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key,source_url,source_version
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
    ORDER BY id`);
  return rows;
}

function actionFor(candidate, rows) {
  const currentRows = rows || [];
  const exact = currentRows.filter((row) =>
    String(row.source_record_id) === String(candidate.sourceRecordId)
    && row.source_variant_key === candidate.sourceVariantKey);
  if (currentRows.length === 1 && exact.length === 1) return 'retain';
  if (currentRows.length === 0) return 'insert';
  return 'replace';
}

export async function build(db, options = {}) {
  const base = await buildLegacyPlan(db, options);
  if (base?.status !== 'audit_complete' || base?.productionWrites !== false) {
    throw new Error('Completed legacy full-market plan required before reverse correction');
  }

  const strict = options.strictReport || JSON.parse(await readFile(STRICT_REPORT(), 'utf8'));
  if (strict?.status !== 'audit_complete' || strict?.productionWrites !== false) {
    throw new Error('Completed exact-proof report required before reverse correction');
  }
  const strictIndex = buildStrictIndex(strict);

  const currentMappings = await currentCardmarketMappings(db);
  const mappingsByIdentity = groupBy(currentMappings, (row) => row.card_identity_id);
  const ownersBySourceKey = groupBy(currentMappings, (row) => sourceKey(row.source_record_id, row.source_variant_key));

  const candidates = new Map((base.certified || []).map((row) => [row.cardIdentityId, Object.freeze({ ...row })]));
  const quarantine = new Map();
  for (const row of base.quarantine || []) {
    if (row.variantCode === 'reverse-holo') {
      const strictRow = strictIndex.resolved.get(row.cardIdentityId);
      const recoveredStrict = reverseCandidateFromStrict(row, strictRow);
      if (recoveredStrict) {
        candidates.set(recoveredStrict.cardIdentityId, recoveredStrict);
        continue;
      }
    }
    if (row.reason === 'CARDMARKET_REVERSE_PRICE_LANE_UNAVAILABLE') {
      const recovered = reverseCandidateFromLegacyQuarantine(row);
      if (recovered) {
        candidates.set(recovered.cardIdentityId, recovered);
        continue;
      }
    }
    quarantine.set(row.cardIdentityId, row);
  }

  // Every exact Cardmarket source key, including the reverse finish lane, has
  // exactly one FateDrop owner. Do not choose a winner if the desired graph is
  // internally ambiguous.
  const desired = groupBy([...candidates.values()], (row) => sourceKey(row.sourceRecordId, row.sourceVariantKey));
  for (const [key, rows] of desired.entries()) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      candidates.delete(row.cardIdentityId);
      quarantine.set(row.cardIdentityId, quarantineFromCandidate(row, 'DESIRED_SOURCE_KEY_COLLISION', {
        sourceKey: key,
        competingIdentityIds: rows.map((candidate) => candidate.cardIdentityId),
      }));
    }
  }

  // Historical ownership may move only when the current foreign owner is also
  // deterministically certified to move away. This is the same safety contract
  // as the standard/holo plan, now applied to reverse instead of quarantining it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [identityId, candidate] of [...candidates.entries()]) {
      const key = sourceKey(candidate.sourceRecordId, candidate.sourceVariantKey);
      const foreignOwnerIds = (ownersBySourceKey.get(key) || [])
        .map((row) => row.card_identity_id)
        .filter((ownerId) => ownerId !== identityId);
      const unsafe = foreignOwnerIds.filter((ownerId) => {
        const ownerCandidate = candidates.get(ownerId);
        if (!ownerCandidate) return true;
        return sourceKey(ownerCandidate.sourceRecordId, ownerCandidate.sourceVariantKey) === key;
      });
      if (!unsafe.length) continue;
      candidates.delete(identityId);
      quarantine.set(identityId, quarantineFromCandidate(candidate, 'SOURCE_KEY_FOREIGN_OWNER_NOT_SAFELY_MOVING', {
        sourceKey: key,
        foreignOwnerIdentityIds: unsafe,
      }));
      changed = true;
    }
  }

  const certified = [...candidates.values()]
    .map((candidate) => {
      const currentRows = mappingsByIdentity.get(candidate.cardIdentityId) || [];
      return Object.freeze({
        ...candidate,
        action: actionFor(candidate, currentRows),
        currentMappings: currentRows.map((row) => ({
          id: row.id,
          sourceRecordId: String(row.source_record_id),
          sourceVariantKey: row.source_variant_key,
          sourceUrl: row.source_url || null,
        })),
      });
    })
    .sort((a, b) => a.cardIdentityId.localeCompare(b.cardIdentityId));

  const quarantined = [...quarantine.values()]
    .sort((a, b) => String(a.cardIdentityId).localeCompare(String(b.cardIdentityId)));
  const expected = Number(base.reconciliation?.expectedVerifiedEnglish || 0);
  if (certified.length + quarantined.length !== expected) {
    throw new Error(`Reconciliation gap after reverse correction: ${expected} != ${certified.length} certified + ${quarantined.length} quarantined`);
  }

  const counts = Object.freeze({
    ...base.counts,
    certified: certified.length,
    retained: certified.filter((row) => row.action === 'retain').length,
    inserts: certified.filter((row) => row.action === 'insert').length,
    replacements: certified.filter((row) => row.action === 'replace').length,
    quarantined: quarantined.length,
    reverseProductResolvedNoPriceLane: 0,
    reverseCertifiedForPublicOffers: certified.filter((row) => row.sourceVariantKey === 'reverse').length,
    reverseProductUnresolved: quarantined.filter((row) => String(row.reason || '').startsWith('CARDMARKET_REVERSE_')).length,
    targetLanePriceable: certified.filter((row) => Boolean(row.priceEvidence?.targetLane)).length,
    reverseOfferPriceEligible: certified.filter((row) => Boolean(row.priceEvidence?.reverseOfferDerived)).length,
    exactMappedButNoTargetPriceLane: certified.filter((row) => !row.priceEvidence?.targetLane).length,
  });

  const reconciliation = Object.freeze({
    expectedVerifiedEnglish: expected,
    certified: certified.length,
    quarantined: quarantined.length,
    explained: certified.length + quarantined.length,
    unexplained: expected - certified.length - quarantined.length,
  });

  return Object.freeze({
    ...base,
    status: 'audit_complete',
    productionWrites: false,
    programme: 'cardmarket_full_market_recertification_v1',
    policy: Object.freeze({
      ...base.policy,
      deterministicSimpleMethod: 'exact FateDrop identity -> pinned TCGdex card/collector -> explicit Cardmarket product ID -> official Cardmarket catalogue',
      reverseHoloMethod: 'same exact Cardmarket URL/product-ID mapping; source_variant_key=reverse; price is extracted separately from public English reverse-holo listings',
      reverseHoloPriceTerminology: 'offer-derived only; never represented as Cardmarket Trend/AVG or completed-sales evidence',
      authenticatedCardmarketApiRequired: false,
      noReverseFallbackToNormalOrHolo: true,
    }),
    counts,
    reconciliation,
    certifiedDigest: candidateDigest(certified),
    certified: Object.freeze(certified),
    quarantine: Object.freeze(quarantined),
  });
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
  await writeFile(OUTPUT(), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    error: report.error,
    counts: report.counts,
    reconciliation: report.reconciliation,
    certifiedDigest: report.certifiedDigest,
    quarantineSample: report.quarantine?.slice?.(0, 20),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
