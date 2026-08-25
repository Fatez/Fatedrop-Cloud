import { createHash } from 'node:crypto';

export const TRADE_OPPORTUNITY_CLASSES = Object.freeze({
  EXACT: 'exact_trade_found',
  STRONG: 'strong_potential_match',
  POTENTIAL: 'potential_trader',
  NONE: 'no_match',
});

export const TRADE_OPPORTUNITY_HEADLINES = Object.freeze({
  [TRADE_OPPORTUNITY_CLASSES.EXACT]: 'FATE TRADE FOUND',
  [TRADE_OPPORTUNITY_CLASSES.STRONG]: 'STRONG POTENTIAL MATCH',
  [TRADE_OPPORTUNITY_CLASSES.POTENTIAL]: 'POTENTIAL TRADER',
  [TRADE_OPPORTUNITY_CLASSES.NONE]: 'NO MATCH',
});

export const TRADE_COMPATIBILITY_WEIGHTS = Object.freeze({
  desiredCard: 40,
  reciprocal: 25,
  copyCompatibility: 15,
  tradeMethod: 10,
  flexibility: 5,
  freshness: 5,
});

export const TRADE_COMPATIBILITY_THRESHOLDS = Object.freeze({
  strong: 70,
  potential: 50,
});

const CONDITION_RANK = Object.freeze({
  unknown: 0,
  damaged: 1,
  heavily_played: 2,
  moderately_played: 3,
  lightly_played: 4,
  near_mint: 5,
  mint: 6,
});

const FLEXIBILITY_SCORE = Object.freeze({
  open: 5,
  negotiable: 5,
  bundle_ok: 5,
  one_for_one: 3,
  exact_wants_only: 0,
});

function text(value) {
  return value == null ? '' : String(value).trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedCardPool(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

function cardRelation(want, offeredCardId) {
  const cardId = text(offeredCardId);
  if (!want || !cardId) return 'none';
  if (text(want.fateCardId) === cardId) return 'exact';
  if (normalizedCardPool(want.acceptableFateCardIds).includes(cardId)) return 'acceptable';
  return 'none';
}

function activeNetworkOffer(offer) {
  if (!offer || typeof offer !== 'object') return false;
  if (lower(offer.status || 'available') !== 'available') return false;
  if (lower(offer.visibility || 'network') !== 'network') return false;
  if (offer.effectiveAvailable === false) return false;
  return positiveInt(offer.tradeQuantity, 0) > 0;
}

function enabledMethods(value = {}) {
  const methods = [];
  if (value.localTradeAllowed !== false) methods.push('local');
  if (value.postalTradeAllowed !== false) methods.push('postal');
  return methods;
}

function commonTradeMethods(a, b) {
  const right = new Set(enabledMethods(b));
  return enabledMethods(a).filter((method) => right.has(method));
}

function normalizedGradingCompany(grading) {
  return lower(grading?.gradingCompany);
}

function offerCopyState(offer) {
  return lower(offer?.copyState || 'raw');
}

function checkCopyCompatibility(offer, constraints = {}) {
  const copyState = offerCopyState(offer);
  const wantedState = lower(constraints.copyState || 'any');
  if (!['raw', 'graded'].includes(copyState)) {
    return { ok: false, score: 0, reason: 'offer_copy_state_unknown' };
  }
  if (!['any', 'raw', 'graded'].includes(wantedState)) {
    return { ok: false, score: 0, reason: 'want_copy_state_invalid' };
  }
  if (wantedState !== 'any' && wantedState !== copyState) {
    return { ok: false, score: 0, reason: 'copy_state_mismatch' };
  }

  if (copyState === 'raw') {
    const minimum = lower(constraints.minimumConditionCode || '');
    const actual = lower(offer.conditionCode || 'unknown');
    if (minimum && minimum !== 'unknown') {
      const requiredRank = CONDITION_RANK[minimum];
      const actualRank = CONDITION_RANK[actual];
      if (requiredRank == null || actualRank == null || actualRank < requiredRank) {
        return { ok: false, score: 0, reason: 'raw_condition_below_minimum' };
      }
      return { ok: true, score: TRADE_COMPATIBILITY_WEIGHTS.copyCompatibility, reason: 'raw_condition_satisfied' };
    }
    const score = actual === 'unknown' ? 10 : 12;
    return { ok: true, score, reason: actual === 'unknown' ? 'raw_condition_unspecified' : 'raw_copy_compatible' };
  }

  const grading = offer.grading || {};
  const gradeValue = numberOrNull(grading.gradeValue);
  const minimumGrade = numberOrNull(constraints.minimumGrade);
  const maximumGrade = numberOrNull(constraints.maximumGrade);
  const accepted = Array.isArray(constraints.acceptedGradingCompanies)
    ? constraints.acceptedGradingCompanies.map(lower).filter(Boolean)
    : [];

  if ((minimumGrade != null || maximumGrade != null) && gradeValue == null) {
    return { ok: false, score: 0, reason: 'graded_value_missing' };
  }
  if (minimumGrade != null && gradeValue < minimumGrade) {
    return { ok: false, score: 0, reason: 'grade_below_minimum' };
  }
  if (maximumGrade != null && gradeValue > maximumGrade) {
    return { ok: false, score: 0, reason: 'grade_above_maximum' };
  }
  if (accepted.length) {
    const company = normalizedGradingCompany(grading);
    if (!company || !accepted.includes(company)) {
      return { ok: false, score: 0, reason: 'grading_company_not_accepted' };
    }
  }
  const explicit = wantedState === 'graded' || minimumGrade != null || maximumGrade != null || accepted.length > 0;
  return {
    ok: true,
    score: explicit ? TRADE_COMPATIBILITY_WEIGHTS.copyCompatibility : 12,
    reason: explicit ? 'graded_constraints_satisfied' : 'graded_copy_compatible',
  };
}

function freshnessScore(updatedAt, now) {
  const stamp = Date.parse(updatedAt || '');
  if (!Number.isFinite(stamp)) return 0;
  const ageMs = Math.max(0, now - stamp);
  const days = ageMs / 86_400_000;
  if (days <= 1) return 5;
  if (days <= 7) return 4;
  if (days <= 30) return 2;
  if (days <= 90) return 1;
  return 0;
}

function methodScore(methods) {
  if (methods.length >= 2) return 10;
  if (methods.length === 1) return 7;
  return 0;
}

function wantMatchesOffer(want, offer) {
  if (!want || want.active === false) return { ok: false, relation: 'none', methods: [], copy: null, quantitySatisfied: false };
  const relation = cardRelation(want, offer?.fateCardId);
  if (relation === 'none') {
    return { ok: false, relation, methods: [], copy: null, quantitySatisfied: false };
  }
  if (!activeNetworkOffer(offer)) return { ok: false, relation, methods: [], copy: null, quantitySatisfied: false };
  const constraints = want.constraints || want;
  const copy = checkCopyCompatibility(offer, constraints);
  if (!copy.ok) return { ok: false, relation, methods: [], copy, quantitySatisfied: false };
  const methods = commonTradeMethods(constraints, offer);
  if (!methods.length) return { ok: false, relation, methods, copy, quantitySatisfied: false };
  const quantitySatisfied = positiveInt(offer.tradeQuantity, 0) >= positiveInt(want.quantity, 1);
  return { ok: true, relation, methods, copy, quantitySatisfied };
}

function findReciprocalEvidence(seekerOffers, candidateWants) {
  const hits = [];
  for (const offer of seekerOffers || []) {
    if (!activeNetworkOffer(offer)) continue;
    for (const want of candidateWants || []) {
      const match = wantMatchesOffer(want, offer);
      if (!match.ok || !match.quantitySatisfied) continue;
      hits.push(Object.freeze({
        relation: match.relation,
        fateCardId: offer.fateCardId,
        binderItemId: offer.id || offer.binderItemId || null,
        wantId: want.id || null,
        methods: Object.freeze([...match.methods]),
      }));
    }
  }
  return Object.freeze(hits);
}

function reciprocalScore(evidence) {
  if (evidence.some((row) => row.relation === 'exact')) return 25;
  if (evidence.some((row) => row.relation === 'acceptable')) return 18;
  return 0;
}

function opportunityFingerprint({ seekerUserId, candidateUserId, targetCardId, offeredTargetCardId, candidateOfferId, reciprocalEvidence }) {
  const reciprocalCards = reciprocalEvidence
    .map((row) => `${row.relation}:${row.fateCardId}`)
    .sort()
    .join(',');
  const input = [seekerUserId, candidateUserId, targetCardId, offeredTargetCardId, candidateOfferId, reciprocalCards]
    .map(text)
    .join('|');
  return `fdtradeopp_${createHash('sha256').update(input).digest('hex').slice(0, 24)}`;
}

function noneResult(reasons, context = {}) {
  const opportunityClass = TRADE_OPPORTUNITY_CLASSES.NONE;
  return Object.freeze({
    opportunityClass,
    headline: TRADE_OPPORTUNITY_HEADLINES[opportunityClass],
    score: 0,
    scoreBreakdown: Object.freeze({ desiredCard: 0, reciprocal: 0, copyCompatibility: 0, tradeMethod: 0, flexibility: 0, freshness: 0 }),
    targetRelation: 'none',
    verifiedReciprocal: false,
    compatibleReciprocal: false,
    fateTradeFoundEligible: false,
    finderEligible: false,
    evidence: Object.freeze([]),
    hardRejects: Object.freeze([...reasons]),
    commonTradeMethods: Object.freeze([]),
    reciprocalEvidence: Object.freeze([]),
    fingerprint: null,
    ...context,
  });
}

/**
 * Scores intent compatibility only. It deliberately does not inspect card prices,
 * cash values or subjective trade fairness.
 *
 * `acceptableFateCardIds` is an optional future-facing pool on either side of a
 * Want. Pool overlap can create potential opportunities, but only exact primary
 * Want ↔ exact primary Want reciprocity is eligible for `FATE TRADE FOUND`.
 */
export function evaluateTradeOpportunity({ seeker, targetWant, candidate, now = Date.now() } = {}) {
  const seekerUserId = text(seeker?.userId);
  const candidateUserId = text(candidate?.userId);
  const targetCardId = text(targetWant?.fateCardId);
  const offer = candidate?.offer;
  const offeredTargetCardId = text(offer?.fateCardId);
  const candidateOfferId = text(offer?.id || offer?.binderItemId);

  if (!seekerUserId || !candidateUserId) return noneResult(['user_identity_missing']);
  if (seekerUserId === candidateUserId) return noneResult(['self_match']);
  if (!targetWant || targetWant.active === false || !targetCardId) return noneResult(['target_want_inactive']);

  const targetRelation = cardRelation(targetWant, offeredTargetCardId);
  if (!offer || targetRelation === 'none') return noneResult(['candidate_does_not_offer_compatible_target_card']);
  if (!activeNetworkOffer(offer)) return noneResult(['candidate_offer_not_tradeable']);

  const targetConstraints = targetWant.constraints || targetWant;
  const copy = checkCopyCompatibility(offer, targetConstraints);
  if (!copy.ok) return noneResult([copy.reason]);

  const methods = commonTradeMethods(targetConstraints, offer);
  if (!methods.length) return noneResult(['trade_method_incompatible']);

  const reciprocalEvidence = findReciprocalEvidence(seeker?.offers || [], candidate?.wants || []);
  const verifiedReciprocal = reciprocalEvidence.some((row) => row.relation === 'exact');
  const compatibleReciprocal = reciprocalEvidence.length > 0;
  const tradeMode = lower(offer.tradeMode || 'open');
  if (tradeMode === 'exact_wants_only' && !verifiedReciprocal) {
    return noneResult(['candidate_requires_exact_want'], { targetCardId, offeredTargetCardId, candidateOfferId });
  }

  const requestedQuantity = positiveInt(targetWant.quantity, 1);
  const offeredQuantity = positiveInt(offer.tradeQuantity, 0);
  const targetQuantitySatisfied = offeredQuantity >= requestedQuantity;
  const desiredScore = targetRelation === 'exact'
    ? (targetQuantitySatisfied ? 40 : 32)
    : (targetQuantitySatisfied ? 32 : 26);

  const scoreBreakdown = {
    desiredCard: desiredScore,
    reciprocal: reciprocalScore(reciprocalEvidence),
    copyCompatibility: copy.score,
    tradeMethod: methodScore(methods),
    flexibility: verifiedReciprocal && tradeMode === 'exact_wants_only'
      ? 5
      : (FLEXIBILITY_SCORE[tradeMode] ?? 2),
    freshness: freshnessScore(offer.updatedAt || offer.createdAt, now),
  };
  const score = Math.min(100, Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0));

  const evidence = [
    targetRelation === 'exact' ? 'candidate_has_exact_wanted_card' : 'candidate_matches_acceptable_card_pool',
    copy.reason,
    `trade_method_${methods.join('_and_')}`,
  ];
  if (verifiedReciprocal) evidence.push('exact_reciprocal_want_overlap');
  else if (compatibleReciprocal) evidence.push('compatible_reciprocal_pool_overlap');
  else if (['open', 'negotiable', 'bundle_ok'].includes(tradeMode)) evidence.push('candidate_open_to_flexible_trade');
  if (!targetQuantitySatisfied) evidence.push('target_quantity_partially_satisfied');

  const exact = targetRelation === 'exact' && verifiedReciprocal && targetQuantitySatisfied;
  let opportunityClass = TRADE_OPPORTUNITY_CLASSES.NONE;
  if (exact) opportunityClass = TRADE_OPPORTUNITY_CLASSES.EXACT;
  else if (score >= TRADE_COMPATIBILITY_THRESHOLDS.strong) opportunityClass = TRADE_OPPORTUNITY_CLASSES.STRONG;
  else if (score >= TRADE_COMPATIBILITY_THRESHOLDS.potential) opportunityClass = TRADE_OPPORTUNITY_CLASSES.POTENTIAL;

  const fingerprint = opportunityFingerprint({
    seekerUserId,
    candidateUserId,
    targetCardId,
    offeredTargetCardId,
    candidateOfferId,
    reciprocalEvidence,
  });

  return Object.freeze({
    opportunityClass,
    headline: TRADE_OPPORTUNITY_HEADLINES[opportunityClass],
    score,
    scoreBreakdown: Object.freeze(scoreBreakdown),
    targetRelation,
    verifiedReciprocal,
    compatibleReciprocal,
    fateTradeFoundEligible: exact,
    finderEligible: opportunityClass !== TRADE_OPPORTUNITY_CLASSES.NONE,
    targetQuantitySatisfied,
    evidence: Object.freeze(evidence),
    hardRejects: Object.freeze([]),
    commonTradeMethods: Object.freeze([...methods]),
    reciprocalEvidence,
    targetCardId,
    offeredTargetCardId,
    candidateOfferId: candidateOfferId || null,
    seekerUserId,
    candidateUserId,
    fingerprint,
  });
}

export function rankTradeOpportunities(opportunities = []) {
  const priority = Object.freeze({
    [TRADE_OPPORTUNITY_CLASSES.EXACT]: 3,
    [TRADE_OPPORTUNITY_CLASSES.STRONG]: 2,
    [TRADE_OPPORTUNITY_CLASSES.POTENTIAL]: 1,
    [TRADE_OPPORTUNITY_CLASSES.NONE]: 0,
  });
  return [...opportunities]
    .filter((row) => row?.finderEligible)
    .sort((a, b) => {
      const classDelta = (priority[b.opportunityClass] || 0) - (priority[a.opportunityClass] || 0);
      if (classDelta) return classDelta;
      const scoreDelta = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDelta) return scoreDelta;
      return text(a.fingerprint).localeCompare(text(b.fingerprint));
    });
}
