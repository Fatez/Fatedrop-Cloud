import { RAW_CONDITIONS } from '../collection/model.mjs';

export const SAFE_EXCHANGE_METHODS = Object.freeze({
  HUB: 'hub',
  POSTAL: 'postal',
});

export const SAFE_EXCHANGE_STATES = Object.freeze({
  DRAFT: 'draft',
  AGREED: 'agreed',
  CHECKED_IN: 'checked_in',
  IN_TRANSIT: 'in_transit',
  INSPECTED: 'inspected',
  CONFIRMING: 'confirming',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const SAFE_EXCHANGE_EVENTS = Object.freeze({
  AGREE: 'agree',
  HUB_CHECK_IN: 'hub_check_in',
  POST: 'post',
  INSPECT: 'inspect',
  BEGIN_CONFIRMATION: 'begin_confirmation',
  COMPLETE: 'complete',
  CANCEL: 'cancel',
});

const TERMINAL_STATES = new Set([
  SAFE_EXCHANGE_STATES.COMPLETED,
  SAFE_EXCHANGE_STATES.CANCELLED,
]);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function nonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeAssets(value) {
  if (!Array.isArray(value)) return [];
  return value.map((asset) => Object.freeze({
    collectionItemId: text(asset?.collectionItemId) || null,
    fateCardId: text(asset?.fateCardId),
    quantity: nonNegativeInt(asset?.quantity) ?? 0,
    copyState: text(asset?.copyState || 'unspecified').toLowerCase(),
    conditionCode: text(asset?.conditionCode).toLowerCase() || null,
    gradingCompany: text(asset?.gradingCompany) || null,
    gradeValue: asset?.gradeValue == null ? null : Number(asset.gradeValue),
  }));
}

function normalizeCommitment(value = {}) {
  return Object.freeze({
    assets: Object.freeze(normalizeAssets(value.assets)),
    cashPence: nonNegativeInt(value.cashPence) ?? 0,
    currency: text(value.currency || 'GBP').toUpperCase(),
  });
}

function validateCommitment(commitment, side) {
  const errors = [];
  if (commitment.currency !== 'GBP') errors.push(`${side}_unsupported_currency`);
  for (const asset of commitment.assets) {
    if (!asset.fateCardId) errors.push(`${side}_card_identity_missing`);
    if (asset.quantity <= 0) errors.push(`${side}_card_quantity_invalid`);
    if (!['raw', 'graded'].includes(asset.copyState)) {
      errors.push(`${side}_copy_state_invalid`);
      continue;
    }
    if (asset.copyState === 'raw') {
      if (!asset.conditionCode || !RAW_CONDITIONS.includes(asset.conditionCode)) errors.push(`${side}_condition_invalid`);
      if (asset.gradingCompany || asset.gradeValue != null) errors.push(`${side}_raw_grading_not_allowed`);
    } else {
      if (asset.conditionCode) errors.push(`${side}_graded_condition_not_allowed`);
      if (!asset.gradingCompany) errors.push(`${side}_grading_company_missing`);
      if (asset.gradeValue == null || !Number.isFinite(asset.gradeValue) || asset.gradeValue < 0) errors.push(`${side}_grade_invalid`);
      if (asset.quantity !== 1) errors.push(`${side}_graded_quantity_invalid`);
    }
  }
  if (commitment.assets.length === 0 && commitment.cashPence <= 0) errors.push(`${side}_commitment_empty`);
  return errors;
}

export function createSafeExchangeAgreement({
  transactionId,
  partyAUserId,
  partyBUserId,
  partyACommitment,
  partyBCommitment,
  method = SAFE_EXCHANGE_METHODS.HUB,
  hubId = null,
} = {}) {
  const normalized = {
    transactionId: text(transactionId),
    partyAUserId: text(partyAUserId),
    partyBUserId: text(partyBUserId),
    partyACommitment: normalizeCommitment(partyACommitment),
    partyBCommitment: normalizeCommitment(partyBCommitment),
    method: text(method),
    hubId: text(hubId) || null,
  };

  const errors = [];
  if (!normalized.transactionId) errors.push('transaction_id_missing');
  if (!normalized.partyAUserId || !normalized.partyBUserId) errors.push('party_identity_missing');
  if (normalized.partyAUserId && normalized.partyAUserId === normalized.partyBUserId) errors.push('self_exchange_not_allowed');
  if (!Object.values(SAFE_EXCHANGE_METHODS).includes(normalized.method)) errors.push('exchange_method_invalid');
  if (normalized.method === SAFE_EXCHANGE_METHODS.HUB && !normalized.hubId) errors.push('hub_id_required');
  errors.push(...validateCommitment(normalized.partyACommitment, 'party_a'));
  errors.push(...validateCommitment(normalized.partyBCommitment, 'party_b'));

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    agreement: errors.length === 0 ? Object.freeze(normalized) : null,
  });
}

/**
 * Validates a short-lived, transaction-bound Hub proof. The protocol deliberately
 * rejects permanent/static QR proofs: the proof must have an issued/expiry window,
 * match the exact transaction and hub, and live for no more than 15 minutes.
 */
export function validateHubProof(proof, { transactionId, hubId, now = Date.now() } = {}) {
  if (!proof || typeof proof !== 'object') return Object.freeze({ ok: false, reason: 'hub_proof_missing' });
  if (text(proof.transactionId) !== text(transactionId)) return Object.freeze({ ok: false, reason: 'hub_proof_transaction_mismatch' });
  if (text(proof.hubId) !== text(hubId)) return Object.freeze({ ok: false, reason: 'hub_proof_hub_mismatch' });
  if (!text(proof.sessionId)) return Object.freeze({ ok: false, reason: 'hub_proof_session_missing' });

  const issuedAt = Date.parse(String(proof.issuedAt || ''));
  const expiresAt = Date.parse(String(proof.expiresAt || ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return Object.freeze({ ok: false, reason: 'hub_proof_window_invalid' });
  }
  if ((expiresAt - issuedAt) > 15 * 60 * 1000) return Object.freeze({ ok: false, reason: 'hub_proof_ttl_too_long' });
  if (now < issuedAt || now >= expiresAt) return Object.freeze({ ok: false, reason: 'hub_proof_expired_or_not_active' });
  return Object.freeze({ ok: true, reason: 'hub_proof_valid' });
}

function bothConfirmed(context = {}) {
  return context.partyAConfirmed === true && context.partyBConfirmed === true;
}

export function nextSafeExchangeState({ state, event, agreement, context = {} } = {}) {
  const current = text(state);
  const action = text(event);
  if (!Object.values(SAFE_EXCHANGE_STATES).includes(current)) {
    return Object.freeze({ ok: false, state: current, reason: 'state_invalid' });
  }
  if (TERMINAL_STATES.has(current)) {
    return Object.freeze({ ok: false, state: current, reason: 'exchange_already_terminal' });
  }

  if (action === SAFE_EXCHANGE_EVENTS.CANCEL) {
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.CANCELLED, reason: 'exchange_cancelled' });
  }

  if (!agreement) return Object.freeze({ ok: false, state: current, reason: 'agreement_missing' });

  if (current === SAFE_EXCHANGE_STATES.DRAFT && action === SAFE_EXCHANGE_EVENTS.AGREE) {
    if (context.partyAAgreed !== true || context.partyBAgreed !== true) {
      return Object.freeze({ ok: false, state: current, reason: 'dual_agreement_required' });
    }
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.AGREED, reason: 'dual_agreement_recorded' });
  }

  if (current === SAFE_EXCHANGE_STATES.AGREED && action === SAFE_EXCHANGE_EVENTS.HUB_CHECK_IN) {
    if (agreement.method !== SAFE_EXCHANGE_METHODS.HUB) {
      return Object.freeze({ ok: false, state: current, reason: 'hub_check_in_not_valid_for_method' });
    }
    const proof = validateHubProof(context.hubProof, {
      transactionId: agreement.transactionId,
      hubId: agreement.hubId,
      now: context.now ?? Date.now(),
    });
    if (!proof.ok) return Object.freeze({ ok: false, state: current, reason: proof.reason });
    if (context.partyACheckedIn !== true || context.partyBCheckedIn !== true) {
      return Object.freeze({ ok: false, state: current, reason: 'dual_hub_check_in_required' });
    }
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.CHECKED_IN, reason: 'hub_presence_verified' });
  }

  if (current === SAFE_EXCHANGE_STATES.AGREED && action === SAFE_EXCHANGE_EVENTS.POST) {
    if (agreement.method !== SAFE_EXCHANGE_METHODS.POSTAL) {
      return Object.freeze({ ok: false, state: current, reason: 'postal_dispatch_not_valid_for_method' });
    }
    if (!text(context.partyATrackingRef) || !text(context.partyBTrackingRef)) {
      return Object.freeze({ ok: false, state: current, reason: 'dual_tracking_required' });
    }
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.IN_TRANSIT, reason: 'tracked_dispatch_recorded' });
  }

  const inspectionSourceValid = (
    (current === SAFE_EXCHANGE_STATES.CHECKED_IN && agreement.method === SAFE_EXCHANGE_METHODS.HUB)
    || (current === SAFE_EXCHANGE_STATES.IN_TRANSIT && agreement.method === SAFE_EXCHANGE_METHODS.POSTAL && context.partyADelivered === true && context.partyBDelivered === true)
  );
  if (inspectionSourceValid && action === SAFE_EXCHANGE_EVENTS.INSPECT) {
    if (context.partyAInspected !== true || context.partyBInspected !== true) {
      return Object.freeze({ ok: false, state: current, reason: 'dual_inspection_required' });
    }
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.INSPECTED, reason: 'dual_inspection_recorded' });
  }

  if (current === SAFE_EXCHANGE_STATES.INSPECTED && action === SAFE_EXCHANGE_EVENTS.BEGIN_CONFIRMATION) {
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.CONFIRMING, reason: 'handoff_confirmation_open' });
  }

  if (current === SAFE_EXCHANGE_STATES.CONFIRMING && action === SAFE_EXCHANGE_EVENTS.COMPLETE) {
    if (!bothConfirmed(context)) {
      return Object.freeze({ ok: false, state: current, reason: 'dual_completion_confirmation_required' });
    }
    return Object.freeze({ ok: true, state: SAFE_EXCHANGE_STATES.COMPLETED, reason: 'exchange_completed' });
  }

  return Object.freeze({ ok: false, state: current, reason: 'transition_not_allowed' });
}
