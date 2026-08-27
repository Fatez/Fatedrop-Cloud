function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finiteNonNegative(value)));
}

function boolScore(value) {
  return value === true ? 1 : 0;
}

export const FATE_TRUST_WEIGHTS = Object.freeze({
  successfulHistory: 0.30,
  verificationStrength: 0.20,
  accountIntegrity: 0.15,
  counterpartyDiversity: 0.15,
  valueExperience: 0.10,
  verifiedFeedback: 0.10,
});

export const FATE_TRUST_EVIDENCE_WEIGHTS = Object.freeze({
  hub: 1,
  trackedPostal: 0.75,
  dualConfirmed: 0.40,
});

export const FATE_TRUST_PENALTIES = Object.freeze({
  minorFulfilment: 50,
  significantDispute: 150,
  confirmedFraud: 400,
});

export function effectiveVerifiedTrades(evidence = {}) {
  return (
    finiteNonNegative(evidence.hubTrades) * FATE_TRUST_EVIDENCE_WEIGHTS.hub
    + finiteNonNegative(evidence.trackedPostalTrades) * FATE_TRUST_EVIDENCE_WEIGHTS.trackedPostal
    + finiteNonNegative(evidence.dualConfirmedTrades) * FATE_TRUST_EVIDENCE_WEIGHTS.dualConfirmed
  );
}

export function evidenceConfidence(effectiveTrades) {
  const n = finiteNonNegative(effectiveTrades);
  return 0.35 + (0.65 * (1 - Math.exp(-n / 12)));
}

export function trustCeiling(effectiveTrades) {
  const n = finiteNonNegative(effectiveTrades);
  return 250 + (750 * (1 - Math.exp(-n / 15)));
}

function successfulHistoryScore(evidence, effectiveTrades) {
  const failures = finiteNonNegative(evidence.failedTrades);
  if (effectiveTrades <= 0 && failures <= 0) return 0;
  // Bayesian smoothing avoids tiny perfect histories looking equivalent to mature histories.
  return clamp01((effectiveTrades + 4) / (effectiveTrades + failures + 5));
}

function verificationStrengthScore(evidence) {
  const hub = finiteNonNegative(evidence.hubTrades);
  const postal = finiteNonNegative(evidence.trackedPostalTrades);
  const dual = finiteNonNegative(evidence.dualConfirmedTrades);
  const totalCompleted = hub + postal + dual;
  if (totalCompleted <= 0) return 0;
  return clamp01((hub + (0.75 * postal) + (0.40 * dual)) / totalCompleted);
}

function accountIntegrityScore(account = {}) {
  const ageDays = finiteNonNegative(account.accountAgeDays);
  const ageScore = Math.min(1, ageDays / 365);
  return clamp01(
    (0.25 * boolScore(account.emailVerified))
    + (0.25 * boolScore(account.phoneVerified))
    + (0.20 * boolScore(account.mfaEnabled))
    + (0.15 * ageScore)
    + (0.15 * clamp01(account.deviceIntegrity)),
  );
}

function counterpartyDiversityScore(evidence = {}) {
  return clamp01(finiteNonNegative(evidence.uniqueCounterparties) / 15);
}

function valueExperienceScore(evidence = {}) {
  const pounds = finiteNonNegative(evidence.verifiedTradeValuePence) / 100;
  return clamp01(Math.log1p(pounds) / Math.log1p(10_000));
}

function verifiedFeedbackScore(evidence = {}) {
  const positive = finiteNonNegative(evidence.positiveVerifiedFeedback);
  const negative = finiteNonNegative(evidence.substantiatedNegativeFeedback);
  if (positive <= 0 && negative <= 0) return 0.5;
  // Negative verified outcomes carry more weight than positive feedback so ratings cannot dominate behaviour.
  return clamp01((positive + 2) / (positive + (2 * negative) + 4));
}

function penaltyScore(evidence = {}) {
  return (
    finiteNonNegative(evidence.substantiatedMinorFulfilments) * FATE_TRUST_PENALTIES.minorFulfilment
    + finiteNonNegative(evidence.substantiatedSignificantDisputes) * FATE_TRUST_PENALTIES.significantDispute
    + finiteNonNegative(evidence.confirmedFraudFindings) * FATE_TRUST_PENALTIES.confirmedFraud
  );
}

export function classifyFateTrust({ score, effectiveTrades, restricted } = {}) {
  if (restricted) return 'restricted';
  const n = finiteNonNegative(effectiveTrades);
  const numericScore = finiteNonNegative(score);
  if (n < 3) return 'unproven';
  if (n < 10 || numericScore < 500) return 'developing';
  if (n < 20 || numericScore < 750) return 'established';
  return 'strong';
}

export function scoreFateTrust({ evidence = {}, account = {} } = {}) {
  const effectiveTrades = effectiveVerifiedTrades(evidence);
  const confidence = evidenceConfidence(effectiveTrades);
  const ceiling = trustCeiling(effectiveTrades);

  const components = Object.freeze({
    successfulHistory: successfulHistoryScore(evidence, effectiveTrades),
    verificationStrength: verificationStrengthScore(evidence),
    accountIntegrity: accountIntegrityScore(account),
    counterpartyDiversity: counterpartyDiversityScore(evidence),
    valueExperience: valueExperienceScore(evidence),
    verifiedFeedback: verifiedFeedbackScore(evidence),
  });

  const weighted = Object.entries(FATE_TRUST_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + (components[key] * weight), 0);
  const penalties = penaltyScore(evidence);
  const rawScore = (1000 * confidence * weighted) - penalties;
  const score = Math.max(0, Math.min(1000, Math.round(Math.min(ceiling, rawScore))));
  const restricted = finiteNonNegative(evidence.confirmedFraudFindings) > 0;
  const level = classifyFateTrust({ score, effectiveTrades, restricted });

  return Object.freeze({
    score,
    level,
    restricted,
    effectiveTrades: Number(effectiveTrades.toFixed(2)),
    evidenceConfidence: Number(confidence.toFixed(4)),
    ceiling: Math.round(ceiling),
    components,
    penalties,
  });
}

export function assessExchangeConfidence({
  trust,
  proposedTradeValuePence = 0,
  verifiedTradeValuePence = 0,
  largestVerifiedTradeValuePence = 0,
  method = 'hub',
  hubAvailable = false,
} = {}) {
  const trustScore = finiteNonNegative(trust?.score);
  const restricted = trust?.restricted === true;
  const proposed = finiteNonNegative(proposedTradeValuePence);
  const totalHistory = finiteNonNegative(verifiedTradeValuePence);
  const largestHistory = finiteNonNegative(largestVerifiedTradeValuePence);
  const reasons = [];

  if (restricted) {
    return Object.freeze({ band: 'blocked', score: 0, reasons: Object.freeze(['account_restricted']) });
  }

  let score = Math.min(100, trustScore / 10);
  if (method === 'hub') {
    score += 12;
    reasons.push('hub_exchange_selected');
  } else if (method === 'postal') {
    score -= 8;
    reasons.push('postal_exchange_has_weaker_handoff_evidence');
  }

  if (hubAvailable && method !== 'hub') reasons.push('hub_exchange_available');

  if (proposed > 0) {
    if (largestHistory <= 0) {
      score -= 18;
      reasons.push('no_comparable_verified_value_history');
    } else if (proposed > largestHistory * 3) {
      score -= 25;
      reasons.push('proposed_value_far_above_verified_history');
    } else if (proposed > largestHistory * 1.5) {
      score -= 12;
      reasons.push('proposed_value_above_verified_history');
    } else {
      score += 5;
      reasons.push('proposed_value_within_verified_history');
    }
  }

  if (totalHistory <= 0) reasons.push('limited_verified_trade_history');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score >= 80 ? 'very_high' : score >= 65 ? 'high' : score >= 45 ? 'moderate' : 'low';
  return Object.freeze({ score, band, reasons: Object.freeze(reasons) });
}
