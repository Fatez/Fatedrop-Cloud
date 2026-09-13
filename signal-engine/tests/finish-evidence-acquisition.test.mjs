import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  finishFromCardmarketPayload,
  finishFromScrydexVariantName,
  finishFromTcgplayerSubtype,
  normalizeExplicitFinishEvidence,
} from '../src/trader/value/finish-evidence-normalizer.mjs';
import { buildVariantResolutionActivationPlan, renderDeltaActivationSql } from '../src/trader/value/variant-resolution-activation.mjs';

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
