import assert from 'node:assert/strict';
import test from 'node:test';

import { COB_PIP_SINGLE_COLLECTIONS, normalizeCobPipSingleCandidate } from '../src/trader/value/cob-pip-singles-pilot.mjs';
import { COB_PIP_REVIEWED_CARD_NAME_ALIASES, withCobPipReviewedCardNameAliases } from '../src/trader/value/cob-pip-reviewed-card-name-aliases.mjs';
import { resolveExactRetailSingleCandidate } from '../src/trader/value/retail-single-offers.mjs';

function exactCandidate(binding, title, variantTitle = 'Base') {
  return normalizeCobPipSingleCandidate({
    id: 100,
    title,
    handle: 'reviewed-alias-card',
  }, {
    id: 200,
    title: variantTitle,
    price: '1.00',
    available: true,
  }, { collection: binding, observedAt: Date.parse('2026-09-07T20:00:00.000Z') });
}

function canonicalCard(binding, { collectorNumber, name, variantCode = 'standard' }) {
  return {
    id: 'fdcard_exact', fateCardId: 'fdcard_exact', setId: binding.canonicalSetId,
    tcgCode: 'pokemon', collectorNumber, name, variantCode, languageCode: 'en', verificationStatus: 'verified',
  };
}

test('reviewed aliases stay retailer-collection and collector-number scoped', () => {
  const surging = COB_PIP_REVIEWED_CARD_NAME_ALIASES['pokemon-surging-sparks'];
  assert.equal(surging['9'].Shinnotic, 'Shiinotic');
  assert.equal(surging['65']['Tapu Kolo'], 'Tapu Koko');
  assert.equal(surging['9']['Tapu Kolo'], undefined);
  assert.equal(COB_PIP_REVIEWED_CARD_NAME_ALIASES['pokemon-151'], undefined);
});

test('obvious reviewed spelling correction may resolve only at its exact collector number', () => {
  const binding = withCobPipReviewedCardNameAliases(COB_PIP_SINGLE_COLLECTIONS['pokemon-surging-sparks']);
  const result = resolveExactRetailSingleCandidate(
    exactCandidate(binding, '#009 Shinnotic Surging Sparks'),
    { binding, canonicalCards: [canonicalCard(binding, { collectorNumber: '9', name: 'Shiinotic' })] },
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.cardIdentityId, 'fdcard_exact');
  assert.equal(result.evidence.sourceCardName, 'Shinnotic');
  assert.equal(result.evidence.cardName, 'Shiinotic');
});

test('materially different retailer card names remain quarantined even with matching collector number', () => {
  const binding = withCobPipReviewedCardNameAliases(COB_PIP_SINGLE_COLLECTIONS['pokemon-151']);
  const result = resolveExactRetailSingleCandidate(
    exactCandidate(binding, '#030 Nidoqueen 151'),
    { binding, canonicalCards: [canonicalCard(binding, { collectorNumber: '30', name: 'Nidorina' })] },
  );
  assert.equal(result.status, 'quarantined');
  assert.equal(result.reason, 'exact_identity_not_found');
});

test('semantic mismatches discovered by the live audit are deliberately absent from reviewed aliases', () => {
  assert.equal(COB_PIP_REVIEWED_CARD_NAME_ALIASES['pokemon-ascended-heroes']?.['204'], undefined);
  assert.equal(COB_PIP_REVIEWED_CARD_NAME_ALIASES['pokemon-prismatic-evolutions']?.['108'], undefined);
});
