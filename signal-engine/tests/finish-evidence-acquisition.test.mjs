import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  finishFromCardmarketPayload,
  finishFromScrydexVariantName,
  finishFromTcgplayerSubtype,
  normalizeExplicitFinishEvidence,
  verifySnapshot,
} from '../src/trader/value/finish-evidence-normalizer.mjs';
import { buildVariantResolutionActivationPlan, renderDeltaActivationSql } from '../src/trader/value/variant-resolution-activation.mjs';
import { buildReviewedDecisionManifest } from '../src/trader/value/reviewed-finish-decision-cli.mjs';
import { mergeReviewedFinishDecisions } from '../src/trader/value/persisted-finish-evidence.mjs';

const rawSnapshot = (provider, cardIdentityId, payload) => {
  const rawPayload = JSON.stringify(payload);
  return {
    provider, cardIdentityId, sourceLocator: `https://evidence.example/${provider}/${cardIdentityId}`,
    requestFingerprint: 'x', observedAt: 1_789_000_000_000,
    payloadSha256: createHash('sha256').update(rawPayload).digest('hex'), rawPayload,
  };
};

const target = {
  cardIdentityId: 'fdcard_test', variantCode: 'holo', language: 'en', edition: 'unspecified',
  name: 'Test Pokémon', collectorNumber: '080', tcgdexCardId: 'sm1-80', scrydexCardId: 'sm1-80',
};

test('Scrydex only accepts explicit recognized variant names', () => {
  assert.deepEqual(finishFromScrydexVariantName('unlimitedHolofoil'), { finish: 'holo', quarantined: null });
  assert.deepEqual(finishFromScrydexVariantName('reverseHolofoil'), { finish: 'reverse_holo', quarantined: null });
  assert.deepEqual(finishFromScrydexVariantName('firstEditionHolofoil'), { finish: null, quarantined: 'first_edition' });
  assert.equal(finishFromScrydexVariantName('Rare Holo GX'), null);
});

test('Scrydex exact card crosswalk can prove holo existence', () => {
  const snapshot = rawSnapshot('scrydex', 'fdcard_test', {
    id: 'sm1-80', name: 'Test Pokémon', number: '80', language_code: 'EN',
    variants: [{ name: 'unlimitedHolofoil' }],
  });
  const result = normalizeExplicitFinishEvidence(target, snapshot);
  assert.equal(result.reason, 'explicit_variant_record');
  assert.equal(result.decision.verdict, 'exists');
  assert.equal(result.decision.finish, 'holo');
});

test('absence, rarity and a different explicit Scrydex finish never imply normal', () => {
  const standard = { ...target, variantCode: 'standard', priorExternalRarity: 'Rare' };
  const snapshot = rawSnapshot('scrydex', 'fdcard_test', {
    id: 'sm1-80', name: 'Test Pokémon', number: '80', language_code: 'EN',
    rarity: 'Common', variants: [{ name: 'unlimitedHolofoil' }],
  });
  const result = normalizeExplicitFinishEvidence(standard, snapshot);
  assert.equal(result.decision, null);
  assert.equal(result.reason, 'target_finish_not_explicit');
});

test('TCGplayer accepts explicit subTypeName only after an exact product crosswalk', () => {
  assert.equal(finishFromTcgplayerSubtype('Normal'), 'standard');
  assert.equal(finishFromTcgplayerSubtype('Holofoil'), 'holo');
  assert.equal(finishFromTcgplayerSubtype('Reverse Holofoil'), 'reverse_holo');
  const snapshot = rawSnapshot('tcgplayer', 'fdcard_test', { results: [{ productId: 123, subTypeName: 'Holofoil', marketPrice: 999 }] });
  assert.equal(normalizeExplicitFinishEvidence({ ...target, tcgplayerProductId: 123 }, snapshot).decision, null);
  const proved = normalizeExplicitFinishEvidence({ ...target, tcgplayerProductId: 123, tcgplayerExactCrosswalk: true }, snapshot);
  assert.equal(proved.decision.finish, 'holo');
});

test('TCGplayer complete SKU enumeration can deterministically prove a missing finish', () => {
  const standard = { ...target, variantCode: 'standard', tcgplayerProductId: 123, tcgplayerExactCrosswalk: true };
  const snapshot = rawSnapshot('tcgplayer', 'fdcard_test', {
    mode: 'complete_product_sku_enumeration',
    product: { productId: 123, categoryId: 3 },
    skus: [
      { skuId: 1, productId: 123, languageId: 1, printingId: 11, conditionId: 1 },
      { skuId: 2, productId: 123, languageId: 1, printingId: 12, conditionId: 1 },
    ],
    printings: [
      { printingId: 11, name: 'Holofoil' },
      { printingId: 12, name: 'Reverse Holofoil' },
    ],
    languages: [{ languageId: 1, name: 'English', abbr: 'EN' }],
    completeness: {
      productDetailsComplete: true,
      productSkusComplete: true,
      categoryPrintingsComplete: true,
      categoryLanguagesComplete: true,
      noPagination: true,
      errorsEmpty: true,
    },
  });
  const result = normalizeExplicitFinishEvidence(standard, snapshot);
  assert.equal(result.reason, 'complete_sku_enumeration_excludes_target_finish');
  assert.equal(result.decision.verdict, 'does_not_exist');
  assert.equal(result.decision.basis, 'exact_printing_checklist');
});

test('TCGplayer omission stays unresolved unless completeness is explicit', () => {
  const standard = { ...target, variantCode: 'standard', tcgplayerProductId: 123, tcgplayerExactCrosswalk: true };
  const snapshot = rawSnapshot('tcgplayer', 'fdcard_test', {
    mode: 'complete_product_sku_enumeration',
    product: { productId: 123, categoryId: 3 },
    skus: [{ skuId: 1, productId: 123, languageId: 1, printingId: 11, conditionId: 1 }],
    printings: [{ printingId: 11, name: 'Holofoil' }],
    languages: [{ languageId: 1, name: 'English', abbr: 'EN' }],
    completeness: { productDetailsComplete: true, productSkusComplete: false },
  });
  const result = normalizeExplicitFinishEvidence(standard, snapshot);
  assert.equal(result.decision, null);
  assert.equal(result.reason, 'tcgplayer_sku_completeness_not_proven');
});

test('Cardmarket idProduct alone never proves finish', () => {
  assert.deepEqual(finishFromCardmarketPayload({ idProduct: 123, name: 'Test Pokémon' }), []);
  const snapshot = rawSnapshot('cardmarket', 'fdcard_test', { idProduct: 123, name: 'Test Pokémon' });
  const result = normalizeExplicitFinishEvidence({ ...target, cardmarketProductId: 123 }, snapshot);
  assert.equal(result.decision, null);
  assert.equal(result.reason, 'no_explicit_finish_attribute');
});

test('Cardmarket explicit finish attribute can prove finish without using product id as finish proof', () => {
  const snapshot = rawSnapshot('cardmarket', 'fdcard_test', { idProduct: 123, attributes: { finish: 'Holofoil' } });
  const result = normalizeExplicitFinishEvidence({ ...target, cardmarketProductId: 123 }, snapshot);
  assert.equal(result.decision.finish, 'holo');
});

test('manual and set-rule snapshots are hash-valid but never auto-authorized', () => {
  const manual = rawSnapshot('manual', 'fdcard_test', { observed: 'holo' });
  assert.equal(verifySnapshot(manual).provider, 'manual');
  const result = normalizeExplicitFinishEvidence(target, manual);
  assert.equal(result.decision, null);
  assert.equal(result.reason, 'human_or_rule_review_required');
});

test('manual review requires explicit human confirmation and set rules require checklist basis', () => {
  assert.throws(() => buildReviewedDecisionManifest({
    provider: 'manual', reviewer: 'operator', approvalReference: 'ticket-1',
    reviews: [{ cardIdentityId: 'fdcard_test', finish: 'holo', verdict: 'exists', basis: 'explicit_variant_record', sourceLocator: 'https://evidence.example', evidencePayload: { finish: 'holo' }, observedAt: 1 }],
  }), /humanConfirmed/);
  assert.throws(() => buildReviewedDecisionManifest({
    provider: 'set_rule', reviewer: 'operator', approvalReference: 'rule-1',
    reviews: [{ cardIdentityId: 'fdcard_test', finish: 'holo', verdict: 'exists', basis: 'explicit_variant_record', sourceLocator: 'https://evidence.example', evidencePayload: { finish: 'holo' }, observedAt: 1 }],
  }), /exact_printing_checklist/);
});

test('negative reviewed evidence requires exhaustive sealed-product-aware coverage', () => {
  const base = {
    provider: 'set_rule', reviewer: 'operator', approvalReference: 'rule-negative',
    reviews: [{
      cardIdentityId: 'fdcard_test', finish: 'standard', verdict: 'does_not_exist', basis: 'exact_printing_checklist',
      sourceLocator: 'https://evidence.example/checklist', observedAt: 1,
      evidencePayload: { completeness: { checklistComplete: true, paginationComplete: true, alternateDistributionCovered: true } },
    }],
  };
  assert.throws(() => buildReviewedDecisionManifest(base), /sealed-product\/decklist coverage/);
  base.reviews[0].evidencePayload.completeness.sealedProductDecklistsCovered = true;
  const reviewed = buildReviewedDecisionManifest(base);
  assert.equal(reviewed.decisions[0].verdict, 'does_not_exist');
});

test('invalid-state reversal requires explicit manual supersession confirmation', () => {
  const input = {
    provider: 'manual', reviewer: 'operator', approvalReference: 'restore-1',
    reviews: [{
      cardIdentityId: 'fdcard_test', finish: 'standard', verdict: 'exists', basis: 'explicit_variant_record',
      sourceLocator: 'https://evidence.example/scan', evidencePayload: { physicalScan: true }, observedAt: 1,
      humanConfirmed: true, supersedesReviewReferences: ['old-invalid-review'], reversalReason: 'Previously unknown deck printing surfaced',
    }],
  };
  assert.throws(() => buildReviewedDecisionManifest(input), /reversalConfirmed/);
  input.reviews[0].reversalConfirmed = true;
  const reviewed = buildReviewedDecisionManifest(input);
  assert.deepEqual(reviewed.decisions[0].supersedesReviewReferences, ['old-invalid-review']);
});

test('approved evidence merges cumulatively without duplicating identical reviews', () => {
  const decision = { cardIdentityId: 'fdcard_test', finish: 'holo', language: 'en', edition: 'unspecified', verdict: 'exists', snapshotSha256: 'a'.repeat(64), reviewReference: 'r' };
  assert.equal(mergeReviewedFinishDecisions([decision], [decision]).length, 1);
});

test('delta activation is deterministic and cannot write prices or delete base cards', () => {
  const ledger = {
    productionWrites: false, activationAuthorized: false,
    results: [{
      cardIdentityId: 'fdcard_test', variantCode: 'holo', language: 'en', edition: 'unspecified',
      state: 'ACTIVE_UNPRICED', reason: 'no_supported_current_positive_price',
      evidenceReferences: [{ snapshotSha256: 'a'.repeat(64), reviewReference: 'review-1' }],
    }],
  };
  const plan = buildVariantResolutionActivationPlan(ledger, { classifiedAt: 123 });
  const sql1 = renderDeltaActivationSql(plan);
  const sql2 = renderDeltaActivationSql(plan);
  assert.equal(sql1, sql2);
  assert.equal(plan.priceWrites, false);
  assert.equal(plan.baseCardDeletes, false);
  assert.doesNotMatch(sql1, /market_price\s*=/i);
  assert.doesNotMatch(sql1, /DELETE\s+FROM\s+fatedrop_card_/i);
  assert.match(sql1, /Existing guarded Cardmarket ingestion remains the only price writer/);
});
