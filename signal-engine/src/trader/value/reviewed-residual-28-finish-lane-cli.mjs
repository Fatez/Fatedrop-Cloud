import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { build as buildResidualRecovery, persist as persistResidualRecovery } from './cardmarket-approved-residual-recovery-cli.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';

const CENTRAL_FIELDS = Object.freeze({
  standard: Object.freeze(['trend', 'avg1', 'avg7', 'avg30']),
  holo: Object.freeze(['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']),
});

const FINISH_POLICY = Object.freeze({
  standard: Object.freeze({ priceLane: 'standard', sourceVariantKey: 'normal' }),
  holo: Object.freeze({ priceLane: 'holo', sourceVariantKey: 'holo' }),
});

const FROZEN_REHEARSAL_PATH = new URL('../../../evidence/reviewed-residual-28-rehearsal.json', import.meta.url);

export function positiveCentralFields(row, lane) {
  const fields = CENTRAL_FIELDS[lane] || [];
  return fields.filter((field) => {
    const value = Number(row?.[field]);
    return Number.isFinite(value) && value > 0;
  });
}

export function verifyExactTargetLane(candidate, priceRow) {
  const policy = FINISH_POLICY[candidate?.variantCode];
  if (!policy) return Object.freeze({ approved: false, reason: 'UNSUPPORTED_CANONICAL_FINISH' });
  if (candidate.priceLane !== policy.priceLane) {
    return Object.freeze({ approved: false, reason: 'PRICE_LANE_DOES_NOT_MATCH_CANONICAL_FINISH' });
  }
  if (candidate.sourceVariantKey !== policy.sourceVariantKey) {
    return Object.freeze({ approved: false, reason: 'SOURCE_VARIANT_KEY_DOES_NOT_MATCH_CANONICAL_FINISH' });
  }
  const positiveFields = positiveCentralFields(priceRow, policy.priceLane);
  if (!positiveFields.length) {
    return Object.freeze({ approved: false, reason: 'NO_POSITIVE_CENTRAL_VALUE_IN_EXACT_TARGET_LANE' });
  }
  return Object.freeze({
    approved: true,
    priceLane: policy.priceLane,
    sourceVariantKey: policy.sourceVariantKey,
    positiveCentralFields: Object.freeze(positiveFields),
    finishProofSource: 'cardmarket-public-price-guide-exact-target-lane',
  });
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadFrozenRehearsal() {
  const parsed = JSON.parse(fs.readFileSync(FROZEN_REHEARSAL_PATH, 'utf8'));
  if (parsed.candidateCount !== 28 || !Array.isArray(parsed.candidates) || parsed.candidates.length !== 28) {
    throw new Error(`Frozen rehearsal candidate count drift: ${parsed.candidates?.length ?? 'missing'}`);
  }
  if (!parsed.candidateDigest) throw new Error('Frozen rehearsal is missing its original candidate digest');
  return parsed;
}

function sameCandidate(left, right) {
  return left.id === right.id
    && left.cardIdentityId === right.cardIdentityId
    && left.setId === right.setId
    && left.name === right.name
    && left.collectorNumber === right.collectorNumber
    && left.variantCode === right.variantCode
    && left.tcgdexCardId === right.tcgdexCardId
    && left.sourceRecordId === right.sourceRecordId
    && left.sourceVariantKey === right.sourceVariantKey
    && left.sourceVersion === right.sourceVersion
    && left.cardmarketProductName === right.cardmarketProductName
    && Number(left.sourceExpansionId) === Number(right.sourceExpansionId)
    && left.priceLane === right.priceLane;
}

function assertFrozenCandidateSet(current, frozen) {
  if (current.length !== frozen.length) throw new Error(`Candidate count drift: ${current.length} != ${frozen.length}`);
  for (let index = 0; index < frozen.length; index += 1) {
    if (!sameCandidate(current[index], frozen[index])) {
      throw new Error(`Candidate drift at index ${index}: ${frozen[index].cardIdentityId}`);
    }
  }
}

function assertExpectedActivation(report) {
  const expectedSectionB = Number(process.env.EXPECTED_SECTION_B || 0);
  const expectedApproved = Number(process.env.EXPECTED_APPROVED || 0);
  const expectedFrozenDigest = String(process.env.EXPECTED_FROZEN_CANDIDATE_DIGEST || '').trim();
  if (expectedSectionB > 0 && report.counts.sectionB !== expectedSectionB) {
    throw new Error(`Section B drift: expected ${expectedSectionB}, found ${report.counts.sectionB}`);
  }
  if (expectedApproved > 0 && report.counts.activationApproved !== expectedApproved) {
    throw new Error(`Activation-approved count drift: expected ${expectedApproved}, found ${report.counts.activationApproved}`);
  }
  if (expectedFrozenDigest && report.frozenCandidateDigest !== expectedFrozenDigest) {
    throw new Error('Frozen candidate manifest drift');
  }
  if (process.env.MAPPING_WRITE === 'true' && (!expectedSectionB || !expectedApproved || !expectedFrozenDigest)) {
    throw new Error('Production writes require pinned Section B count, activation-approved count and frozen candidate digest');
  }
}

export async function buildFinishReviewedRelease(db) {
  const frozen = loadFrozenRehearsal();
  const [catalogueSource, guideSource] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);

  if (catalogueSource.artifact.sha256 !== frozen.source.cardmarketCatalogueSha256) {
    throw new Error('Cardmarket catalogue SHA drift from reviewed rehearsal');
  }
  if (String(process.env.TCGDEX_REVISION || '') !== frozen.source.tcgdexRevision) {
    throw new Error('TCGdex revision drift from reviewed rehearsal');
  }

  const base = await buildResidualRecovery(db, {
    sources: { catalogue: catalogueSource, guide: guideSource },
  });
  if (base.status !== 'audit_complete') throw new Error(`Residual recovery did not complete: ${base.status}`);
  if (base.counts.sectionB !== 527) throw new Error(`Expected current Section B 527, found ${base.counts.sectionB}`);
  if (base.counts.safeExactMappings !== 28) throw new Error(`Expected 28 reviewed mapping candidates, found ${base.counts.safeExactMappings}`);
  assertFrozenCandidateSet(base.candidates, frozen.candidates);

  const priceById = new Map(guideSource.snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const approved = [];
  const held = [];
  for (const candidate of base.candidates) {
    const finish = verifyExactTargetLane(candidate, priceById.get(String(candidate.sourceRecordId)));
    if (!finish.approved) {
      held.push(Object.freeze({
        cardIdentityId: candidate.cardIdentityId,
        sourceRecordId: candidate.sourceRecordId,
        variantCode: candidate.variantCode,
        reason: finish.reason,
      }));
      continue;
    }
    approved.push(Object.freeze({
      ...candidate,
      proof: Object.freeze({
        ...candidate.proof,
        finishProofSource: finish.finishProofSource,
        exactRequestedFinish: candidate.variantCode,
        exactCardmarketPriceLane: finish.priceLane,
        exactCardmarketSourceVariantKey: finish.sourceVariantKey,
        positiveCentralFields: finish.positiveCentralFields,
        cardmarketPriceGuideSha256: guideSource.artifact.sha256,
        cardmarketSourceSnapshotId: guideSource.snapshot.sourceSnapshotId,
      }),
    }));
  }

  const activationDigest = digest(approved);
  return Object.freeze({
    ...base,
    productionWrites: false,
    policy: Object.freeze({
      ...base.policy,
      independentFinishProofRequiredForActivation: true,
      independentFinishProof: 'positive central value in exact current Cardmarket public price-guide lane matching canonical finish',
      currentPriceGuideRevalidatedAtActivation: true,
      volatilePriceGuideShaIsEvidenceNotIdentityPin: true,
      oppositeLaneSubstitutionForbidden: true,
      cardmarketProductIdAloneIsNotFinishProof: true,
    }),
    source: Object.freeze({
      ...base.source,
      currentCardmarketPriceGuideSha256: guideSource.artifact.sha256,
      currentCardmarketSourceSnapshotId: guideSource.snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({
      ...base.counts,
      activationApproved: approved.length,
      finishProofHeld: held.length,
    }),
    candidates: Object.freeze(approved),
    finishProofHeld: Object.freeze(held),
    activationDigest,
    frozenCandidateDigest: frozen.candidateDigest,
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildFinishReviewedRelease(db);
    assertExpectedActivation(report);
    if (process.env.MAPPING_WRITE === 'true') {
      if (report.counts.finishProofHeld !== 0) throw new Error('Finish-proof holds remain; production write refused');
      const persistence = await persistResidualRecovery(db, report);
      report = Object.freeze({ ...report, status: 'write_complete', productionWrites: true, persistence });
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/reviewed-residual-28-finish-lane.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    productionWrites: report.productionWrites,
    source: report.source,
    counts: report.counts,
    activationDigest: report.activationDigest,
    frozenCandidateDigest: report.frozenCandidateDigest,
    finishProofHeld: report.finishProofHeld,
    persistence: report.persistence,
    error: report.error,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
