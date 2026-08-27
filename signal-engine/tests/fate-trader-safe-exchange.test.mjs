import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSafeExchangeAgreement,
  nextSafeExchangeState,
  SAFE_EXCHANGE_EVENTS,
  SAFE_EXCHANGE_METHODS,
  SAFE_EXCHANGE_STATES,
  validateHubProof,
} from '../src/trader/safe-exchange/protocol.mjs';

const NOW = Date.parse('2026-08-27T00:30:00Z');

function hubAgreement() {
  const result = createSafeExchangeAgreement({
    transactionId: 'ft_123',
    partyAUserId: 'user-a',
    partyBUserId: 'user-b',
    method: SAFE_EXCHANGE_METHODS.HUB,
    hubId: 'hub-hertford-1',
    partyACommitment: {
      assets: [{ fateCardId: 'card-charizard', quantity: 1, copyState: 'raw', conditionCode: 'near_mint' }],
      cashPence: 8_000,
    },
    partyBCommitment: {
      assets: [{ fateCardId: 'card-umbreon', quantity: 1, copyState: 'raw', conditionCode: 'near_mint' }],
    },
  });
  assert.equal(result.ok, true);
  return result.agreement;
}

function validHubProof(overrides = {}) {
  return {
    transactionId: 'ft_123',
    hubId: 'hub-hertford-1',
    sessionId: 'hubsession_ephemeral_1',
    issuedAt: '2026-08-27T00:25:00Z',
    expiresAt: '2026-08-27T00:35:00Z',
    ...overrides,
  };
}

test('Safe Exchange stores an atomic two-sided agreement with canonical card IDs and GBP cash adjustment', () => {
  const agreement = hubAgreement();

  assert.equal(agreement.partyACommitment.assets[0].fateCardId, 'card-charizard');
  assert.equal(agreement.partyACommitment.cashPence, 8_000);
  assert.equal(agreement.partyACommitment.currency, 'GBP');
  assert.equal(agreement.partyBCommitment.assets[0].fateCardId, 'card-umbreon');
});

test('invalid or empty commitments fail closed', () => {
  const result = createSafeExchangeAgreement({
    transactionId: 'ft_bad',
    partyAUserId: 'user-a',
    partyBUserId: 'user-b',
    method: SAFE_EXCHANGE_METHODS.HUB,
    hubId: 'hub-1',
    partyACommitment: { assets: [] },
    partyBCommitment: { assets: [{ quantity: 1 }] },
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('party_a_commitment_empty'));
  assert.ok(result.errors.includes('party_b_card_identity_missing'));
});

test('Hub proof must be short-lived and bound to the exact transaction and hub', () => {
  assert.equal(validateHubProof(validHubProof(), { transactionId: 'ft_123', hubId: 'hub-hertford-1', now: NOW }).ok, true);
  assert.equal(validateHubProof(validHubProof(), { transactionId: 'ft_other', hubId: 'hub-hertford-1', now: NOW }).reason, 'hub_proof_transaction_mismatch');
  assert.equal(validateHubProof(validHubProof(), { transactionId: 'ft_123', hubId: 'hub-other', now: NOW }).reason, 'hub_proof_hub_mismatch');
  assert.equal(validateHubProof(validHubProof({ expiresAt: '2026-08-27T01:00:00Z' }), { transactionId: 'ft_123', hubId: 'hub-hertford-1', now: NOW }).reason, 'hub_proof_ttl_too_long');
  assert.equal(validateHubProof(validHubProof({ expiresAt: '2026-08-27T00:29:00Z' }), { transactionId: 'ft_123', hubId: 'hub-hertford-1', now: NOW }).reason, 'hub_proof_expired_or_not_active');
});

test('Hub exchange cannot advance without both parties agreeing and checking in', () => {
  const agreement = hubAgreement();
  const missingAgreement = nextSafeExchangeState({
    state: SAFE_EXCHANGE_STATES.DRAFT,
    event: SAFE_EXCHANGE_EVENTS.AGREE,
    agreement,
    context: { partyAAgreed: true, partyBAgreed: false },
  });
  assert.equal(missingAgreement.ok, false);
  assert.equal(missingAgreement.reason, 'dual_agreement_required');

  const agreed = nextSafeExchangeState({
    state: SAFE_EXCHANGE_STATES.DRAFT,
    event: SAFE_EXCHANGE_EVENTS.AGREE,
    agreement,
    context: { partyAAgreed: true, partyBAgreed: true },
  });
  assert.equal(agreed.state, SAFE_EXCHANGE_STATES.AGREED);

  const oneSidedCheckIn = nextSafeExchangeState({
    state: agreed.state,
    event: SAFE_EXCHANGE_EVENTS.HUB_CHECK_IN,
    agreement,
    context: { now: NOW, hubProof: validHubProof(), partyACheckedIn: true, partyBCheckedIn: false },
  });
  assert.equal(oneSidedCheckIn.ok, false);
  assert.equal(oneSidedCheckIn.reason, 'dual_hub_check_in_required');
});

test('full Hub path requires inspection and dual completion confirmation', () => {
  const agreement = hubAgreement();
  const agreed = nextSafeExchangeState({ state: SAFE_EXCHANGE_STATES.DRAFT, event: SAFE_EXCHANGE_EVENTS.AGREE, agreement, context: { partyAAgreed: true, partyBAgreed: true } });
  const checkedIn = nextSafeExchangeState({ state: agreed.state, event: SAFE_EXCHANGE_EVENTS.HUB_CHECK_IN, agreement, context: { now: NOW, hubProof: validHubProof(), partyACheckedIn: true, partyBCheckedIn: true } });
  const inspected = nextSafeExchangeState({ state: checkedIn.state, event: SAFE_EXCHANGE_EVENTS.INSPECT, agreement, context: { partyAInspected: true, partyBInspected: true } });
  const confirming = nextSafeExchangeState({ state: inspected.state, event: SAFE_EXCHANGE_EVENTS.BEGIN_CONFIRMATION, agreement });

  const oneSided = nextSafeExchangeState({ state: confirming.state, event: SAFE_EXCHANGE_EVENTS.COMPLETE, agreement, context: { partyAConfirmed: true, partyBConfirmed: false } });
  assert.equal(oneSided.ok, false);
  assert.equal(oneSided.reason, 'dual_completion_confirmation_required');

  const completed = nextSafeExchangeState({ state: confirming.state, event: SAFE_EXCHANGE_EVENTS.COMPLETE, agreement, context: { partyAConfirmed: true, partyBConfirmed: true } });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, SAFE_EXCHANGE_STATES.COMPLETED);
});

test('cancellation is allowed before completion and completed exchanges are terminal', () => {
  const agreement = hubAgreement();
  const cancelled = nextSafeExchangeState({ state: SAFE_EXCHANGE_STATES.AGREED, event: SAFE_EXCHANGE_EVENTS.CANCEL, agreement });
  assert.equal(cancelled.state, SAFE_EXCHANGE_STATES.CANCELLED);

  const terminal = nextSafeExchangeState({ state: SAFE_EXCHANGE_STATES.COMPLETED, event: SAFE_EXCHANGE_EVENTS.CANCEL, agreement });
  assert.equal(terminal.ok, false);
  assert.equal(terminal.reason, 'exchange_already_terminal');
});
