import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessExchangeConfidence,
  effectiveVerifiedTrades,
  scoreFateTrust,
} from '../src/trader/trust/scoring.mjs';

const strongAccount = Object.freeze({
  emailVerified: true,
  phoneVerified: true,
  mfaEnabled: true,
  accountAgeDays: 500,
  deviceIntegrity: 1,
});

test('Hub exchanges create stronger evidence than postal or user-confirmed exchanges', () => {
  assert.equal(effectiveVerifiedTrades({ hubTrades: 1 }), 1);
  assert.equal(effectiveVerifiedTrades({ trackedPostalTrades: 1 }), 0.75);
  assert.equal(effectiveVerifiedTrades({ dualConfirmedTrades: 1 }), 0.4);
});

test('tiny perfect histories cannot reach elite FateTrust because confidence and ceiling are evidence-bound', () => {
  const result = scoreFateTrust({
    account: strongAccount,
    evidence: {
      hubTrades: 2,
      uniqueCounterparties: 2,
      verifiedTradeValuePence: 2_000,
      positiveVerifiedFeedback: 2,
    },
  });

  assert.equal(result.level, 'unproven');
  assert.ok(result.ceiling < 400);
  assert.ok(result.score < 400);
});

test('mature diversified verified behaviour can become strong without exposing a gameable single input', () => {
  const result = scoreFateTrust({
    account: strongAccount,
    evidence: {
      hubTrades: 24,
      trackedPostalTrades: 12,
      dualConfirmedTrades: 6,
      uniqueCounterparties: 30,
      verifiedTradeValuePence: 1_500_000,
      positiveVerifiedFeedback: 38,
      substantiatedNegativeFeedback: 0,
      failedTrades: 0,
    },
  });

  assert.ok(result.effectiveTrades >= 30);
  assert.ok(result.score >= 750);
  assert.equal(result.level, 'strong');
  assert.equal(result.restricted, false);
});

test('unsubstantiated reports have no scoring input while confirmed outcomes do', () => {
  const baseline = scoreFateTrust({
    account: strongAccount,
    evidence: {
      hubTrades: 15,
      uniqueCounterparties: 15,
      verifiedTradeValuePence: 500_000,
      positiveVerifiedFeedback: 15,
      unsubstantiatedReports: 99,
    },
  });
  const confirmed = scoreFateTrust({
    account: strongAccount,
    evidence: {
      hubTrades: 15,
      uniqueCounterparties: 15,
      verifiedTradeValuePence: 500_000,
      positiveVerifiedFeedback: 15,
      substantiatedSignificantDisputes: 1,
    },
  });

  assert.ok(confirmed.score <= baseline.score - 100);
});

test('confirmed fraud restricts the account independently from the numeric score', () => {
  const result = scoreFateTrust({
    account: strongAccount,
    evidence: {
      hubTrades: 50,
      uniqueCounterparties: 40,
      verifiedTradeValuePence: 5_000_000,
      positiveVerifiedFeedback: 50,
      confirmedFraudFindings: 1,
    },
  });

  assert.equal(result.restricted, true);
  assert.equal(result.level, 'restricted');
});

test('transaction confidence falls when proposed value greatly exceeds verified experience', () => {
  const trust = { score: 820, restricted: false };
  const normal = assessExchangeConfidence({
    trust,
    proposedTradeValuePence: 25_000,
    verifiedTradeValuePence: 300_000,
    largestVerifiedTradeValuePence: 50_000,
    method: 'hub',
    hubAvailable: true,
  });
  const oversized = assessExchangeConfidence({
    trust,
    proposedTradeValuePence: 500_000,
    verifiedTradeValuePence: 300_000,
    largestVerifiedTradeValuePence: 50_000,
    method: 'hub',
    hubAvailable: true,
  });

  assert.ok(normal.score > oversized.score);
  assert.ok(oversized.reasons.includes('proposed_value_far_above_verified_history'));
});

test('the same trader receives stronger exchange confidence at a Hub than by post', () => {
  const trust = { score: 700, restricted: false };
  const hub = assessExchangeConfidence({ trust, proposedTradeValuePence: 10_000, largestVerifiedTradeValuePence: 20_000, method: 'hub' });
  const postal = assessExchangeConfidence({ trust, proposedTradeValuePence: 10_000, largestVerifiedTradeValuePence: 20_000, method: 'postal' });

  assert.ok(hub.score > postal.score);
});
