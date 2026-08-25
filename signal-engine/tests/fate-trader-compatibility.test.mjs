import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTradeOpportunity,
  rankTradeOpportunities,
  TRADE_OPPORTUNITY_CLASSES,
} from '../src/trader/matching/compatibility.mjs';

const NOW = Date.parse('2026-08-25T20:00:00Z');

function offer(overrides = {}) {
  return {
    id: 'offer-target',
    fateCardId: 'card-mew',
    status: 'available',
    visibility: 'network',
    effectiveAvailable: true,
    tradeQuantity: 1,
    copyState: 'raw',
    conditionCode: 'near_mint',
    tradeMode: 'open',
    localTradeAllowed: true,
    postalTradeAllowed: true,
    updatedAt: '2026-08-25T19:00:00Z',
    ...overrides,
  };
}

function seekerOffer(overrides = {}) {
  return {
    id: 'offer-charizard',
    fateCardId: 'card-charizard',
    status: 'available',
    visibility: 'network',
    effectiveAvailable: true,
    tradeQuantity: 1,
    copyState: 'raw',
    conditionCode: 'near_mint',
    tradeMode: 'open',
    localTradeAllowed: true,
    postalTradeAllowed: true,
    updatedAt: '2026-08-25T18:00:00Z',
    ...overrides,
  };
}

function targetWant(overrides = {}) {
  return {
    id: 'want-mew',
    fateCardId: 'card-mew',
    quantity: 1,
    active: true,
    constraints: {
      copyState: 'raw',
      minimumConditionCode: 'near_mint',
      localTradeAllowed: true,
      postalTradeAllowed: true,
    },
    ...overrides,
  };
}

function candidateWant(overrides = {}) {
  return {
    id: 'want-charizard',
    fateCardId: 'card-charizard',
    quantity: 1,
    active: true,
    constraints: {
      copyState: 'raw',
      minimumConditionCode: 'near_mint',
      localTradeAllowed: true,
      postalTradeAllowed: true,
    },
    ...overrides,
  };
}

function evaluate({
  seekerUserId = 'user-a',
  candidateUserId = 'user-b',
  target = targetWant(),
  targetOffer = offer(),
  seekerOffers = [seekerOffer()],
  candidateWants = [candidateWant()],
} = {}) {
  return evaluateTradeOpportunity({
    seeker: { userId: seekerUserId, offers: seekerOffers },
    targetWant: target,
    candidate: { userId: candidateUserId, offer: targetOffer, wants: candidateWants },
    now: NOW,
  });
}

test('verified reciprocal intent produces FATE TRADE FOUND with a full compatibility score', () => {
  const result = evaluate();

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.EXACT);
  assert.equal(result.headline, 'FATE TRADE FOUND');
  assert.equal(result.score, 100);
  assert.equal(result.targetRelation, 'exact');
  assert.equal(result.verifiedReciprocal, true);
  assert.equal(result.compatibleReciprocal, true);
  assert.equal(result.fateTradeFoundEligible, true);
  assert.equal(result.finderEligible, true);
  assert.equal(result.reciprocalEvidence.length, 1);
  assert.ok(result.evidence.includes('exact_reciprocal_want_overlap'));
  assert.match(result.fingerprint, /^fdtradeopp_[a-f0-9]{24}$/);
});

test('wanted card plus open-to-offers behavior becomes a strong potential match without claiming reciprocity', () => {
  const result = evaluate({ candidateWants: [] });

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.STRONG);
  assert.equal(result.headline, 'STRONG POTENTIAL MATCH');
  assert.equal(result.score, 75);
  assert.equal(result.verifiedReciprocal, false);
  assert.equal(result.fateTradeFoundEligible, false);
  assert.equal(result.finderEligible, true);
  assert.ok(result.evidence.includes('candidate_open_to_flexible_trade'));
});

test('acceptable target-card pools create potential matches but never FATE TRADE FOUND', () => {
  const result = evaluate({
    target: targetWant({ acceptableFateCardIds: ['card-mewtwo'] }),
    targetOffer: offer({ fateCardId: 'card-mewtwo' }),
    candidateWants: [],
  });

  assert.equal(result.targetRelation, 'acceptable');
  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.POTENTIAL);
  assert.equal(result.score, 67);
  assert.equal(result.fateTradeFoundEligible, false);
  assert.ok(result.evidence.includes('candidate_matches_acceptable_card_pool'));
});

test('acceptable reciprocal pools can create a strong opportunity without becoming an exact reciprocal event', () => {
  const result = evaluate({
    candidateWants: [candidateWant({
      fateCardId: 'card-blastoise',
      acceptableFateCardIds: ['card-charizard'],
    })],
  });

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.STRONG);
  assert.equal(result.score, 93);
  assert.equal(result.verifiedReciprocal, false);
  assert.equal(result.compatibleReciprocal, true);
  assert.equal(result.fateTradeFoundEligible, false);
  assert.equal(result.reciprocalEvidence[0].relation, 'acceptable');
  assert.ok(result.evidence.includes('compatible_reciprocal_pool_overlap'));
});

test('lower-confidence but viable card-show connection remains a potential trader', () => {
  const result = evaluate({
    candidateWants: [],
    target: {
      ...targetWant(),
      constraints: {
        copyState: 'any',
        localTradeAllowed: true,
        postalTradeAllowed: false,
      },
    },
    targetOffer: offer({
      conditionCode: 'unknown',
      tradeMode: 'one_for_one',
      postalTradeAllowed: false,
      updatedAt: '2026-01-01T00:00:00Z',
    }),
  });

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.POTENTIAL);
  assert.equal(result.headline, 'POTENTIAL TRADER');
  assert.equal(result.score, 60);
  assert.equal(result.fateTradeFoundEligible, false);
  assert.deepEqual(result.commonTradeMethods, ['local']);
});

test('raw condition requirements are hard gates, not soft score deductions', () => {
  const result = evaluate({ targetOffer: offer({ conditionCode: 'lightly_played' }) });

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.NONE);
  assert.equal(result.finderEligible, false);
  assert.deepEqual(result.hardRejects, ['raw_condition_below_minimum']);
});

test('trade method incompatibility fails closed', () => {
  const result = evaluate({
    target: {
      ...targetWant(),
      constraints: {
        copyState: 'raw',
        minimumConditionCode: 'near_mint',
        localTradeAllowed: false,
        postalTradeAllowed: true,
      },
    },
    targetOffer: offer({ localTradeAllowed: true, postalTradeAllowed: false }),
  });

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.NONE);
  assert.deepEqual(result.hardRejects, ['trade_method_incompatible']);
});

test('self matches and non-tradeable listings can never enter Finder', () => {
  const self = evaluate({ candidateUserId: 'user-a' });
  assert.deepEqual(self.hardRejects, ['self_match']);

  const reserved = evaluate({ targetOffer: offer({ status: 'reserved' }) });
  assert.deepEqual(reserved.hardRejects, ['candidate_offer_not_tradeable']);

  const privateOffer = evaluate({ targetOffer: offer({ visibility: 'private' }) });
  assert.deepEqual(privateOffer.hardRejects, ['candidate_offer_not_tradeable']);
});

test('exact-wants-only listings require a real exact reciprocal card overlap', () => {
  const rejected = evaluate({
    targetOffer: offer({ tradeMode: 'exact_wants_only' }),
    candidateWants: [],
  });
  assert.equal(rejected.opportunityClass, TRADE_OPPORTUNITY_CLASSES.NONE);
  assert.deepEqual(rejected.hardRejects, ['candidate_requires_exact_want']);

  const poolOnly = evaluate({
    targetOffer: offer({ tradeMode: 'exact_wants_only' }),
    candidateWants: [candidateWant({ fateCardId: 'card-blastoise', acceptableFateCardIds: ['card-charizard'] })],
  });
  assert.equal(poolOnly.opportunityClass, TRADE_OPPORTUNITY_CLASSES.NONE);
  assert.deepEqual(poolOnly.hardRejects, ['candidate_requires_exact_want']);

  const accepted = evaluate({ targetOffer: offer({ tradeMode: 'exact_wants_only' }) });
  assert.equal(accepted.opportunityClass, TRADE_OPPORTUNITY_CLASSES.EXACT);
  assert.equal(accepted.fateTradeFoundEligible, true);
});

test('partial target quantity can be surfaced but can never be labelled FATE TRADE FOUND', () => {
  const result = evaluate({
    target: targetWant({ quantity: 2 }),
    targetOffer: offer({ tradeQuantity: 1 }),
  });

  assert.equal(result.opportunityClass, TRADE_OPPORTUNITY_CLASSES.STRONG);
  assert.equal(result.score, 92);
  assert.equal(result.targetQuantitySatisfied, false);
  assert.equal(result.verifiedReciprocal, true);
  assert.equal(result.fateTradeFoundEligible, false);
  assert.ok(result.evidence.includes('target_quantity_partially_satisfied'));
});

test('graded constraints validate grade ranges and grading companies', () => {
  const target = {
    ...targetWant(),
    constraints: {
      copyState: 'graded',
      minimumGrade: 9,
      maximumGrade: 10,
      acceptedGradingCompanies: ['PSA'],
      localTradeAllowed: true,
      postalTradeAllowed: true,
    },
  };

  const compatible = evaluate({
    target,
    targetOffer: offer({
      copyState: 'graded',
      conditionCode: null,
      grading: { gradingCompany: 'PSA', gradeValue: 10, gradeLabel: '10' },
    }),
  });
  assert.equal(compatible.finderEligible, true);

  const wrongCompany = evaluate({
    target,
    targetOffer: offer({
      copyState: 'graded',
      conditionCode: null,
      grading: { gradingCompany: 'CGC', gradeValue: 10, gradeLabel: '10' },
    }),
  });
  assert.deepEqual(wrongCompany.hardRejects, ['grading_company_not_accepted']);
});

test('market values never influence compatibility classification or score', () => {
  const baseline = evaluate({ candidateWants: [] });
  const priced = evaluateTradeOpportunity({
    seeker: {
      userId: 'user-a',
      offers: [{ ...seekerOffer(), marketValue: 1000000 }],
      portfolioValue: 9999999,
    },
    targetWant: { ...targetWant(), targetValue: 1 },
    candidate: {
      userId: 'user-b',
      offer: { ...offer(), marketValue: 0.01, askingPrice: 999999 },
      wants: [],
    },
    now: NOW,
  });

  assert.equal(priced.score, baseline.score);
  assert.equal(priced.opportunityClass, baseline.opportunityClass);
  assert.equal(priced.fateTradeFoundEligible, false);
});

test('ranking always places verified reciprocal matches above potential matches', () => {
  const exact = evaluate();
  const strong = evaluate({ candidateUserId: 'user-c', candidateWants: [] });
  const potential = evaluate({
    candidateUserId: 'user-d',
    candidateWants: [],
    target: {
      ...targetWant(),
      constraints: { copyState: 'any', localTradeAllowed: true, postalTradeAllowed: false },
    },
    targetOffer: offer({ conditionCode: 'unknown', tradeMode: 'one_for_one', postalTradeAllowed: false, updatedAt: '2026-01-01T00:00:00Z' }),
  });

  const ranked = rankTradeOpportunities([potential, strong, exact]);
  assert.deepEqual(ranked.map((row) => row.opportunityClass), [
    TRADE_OPPORTUNITY_CLASSES.EXACT,
    TRADE_OPPORTUNITY_CLASSES.STRONG,
    TRADE_OPPORTUNITY_CLASSES.POTENTIAL,
  ]);
});
