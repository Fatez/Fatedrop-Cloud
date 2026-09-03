import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POKEMON_WIZARD_REFERENCE_POLICY,
  buildPokemonWizardManualReference,
  comparePokemonWizardReference,
} from '../src/trader/value/pokemon-wizard-reference.mjs';

const NOW = Date.parse('2026-09-03T10:30:00.000Z');
const CARD = Object.freeze({
  id: 'fdcard_0123456789abcdef01234567',
  verificationStatus: 'verified',
});

function reference(overrides = {}) {
  return buildPokemonWizardManualReference({
    cardIdentity: CARD,
    sourceUrl: 'https://www.pokemonwizard.com/cards/example-card',
    sourceObservedAt: NOW,
    quotedPrice: 125.5,
    currencyCode: 'usd',
    notes: 'Manual internal cross-check only',
    ...overrides,
  });
}

test('Pokemon Wizard lane is manual, transient and non-redistributable', () => {
  const value = reference();

  assert.equal(value.sourceName, 'pokemon-wizard');
  assert.equal(value.acquisitionMode, 'manual-reference');
  assert.equal(value.currencyCode, 'USD');
  assert.equal(value.quotedPrice, 125.5);
  assert.equal(value.automatedAcquisitionAuthorized, false);
  assert.equal(value.persistenceAuthorized, false);
  assert.equal(value.redistributionAuthorized, false);
  assert.equal(value.bulkExtractionAuthorized, false);

  assert.deepEqual(POKEMON_WIZARD_REFERENCE_POLICY, {
    automatedAcquisitionAuthorized: false,
    persistenceAuthorized: false,
    redistributionAuthorized: false,
    bulkExtractionAuthorized: false,
    purpose: 'internal-reference-validation',
  });
});

test('Pokemon Wizard reference requires a verified canonical card identity', () => {
  assert.throws(() => reference({
    cardIdentity: {
      id: CARD.id,
      verificationStatus: 'staged',
    },
  }), /verified canonical card identity/);
});

test('Pokemon Wizard reference rejects non-Pokemon-Wizard URLs and insecure URLs', () => {
  assert.throws(
    () => reference({ sourceUrl: 'https://example.com/cards/example-card' }),
    /HTTPS Pokemon Wizard URL/,
  );
  assert.throws(
    () => reference({ sourceUrl: 'http://www.pokemonwizard.com/cards/example-card' }),
    /HTTPS Pokemon Wizard URL/,
  );
});

test('same-currency comparisons are allowed for transient validation', () => {
  const result = comparePokemonWizardReference(reference(), {
    price: 120,
    currencyCode: 'USD',
  });

  assert.equal(result.comparable, true);
  assert.equal(result.delta, 5.5);
  assert.ok(Math.abs(result.deltaPercent - 4.583333333333333) < 1e-12);
});

test('cross-currency comparisons fail closed instead of inventing FX', () => {
  const result = comparePokemonWizardReference(reference(), {
    price: 110,
    currencyCode: 'EUR',
  });

  assert.deepEqual(result, {
    comparable: false,
    reason: 'currency_mismatch_fx_required',
    referenceCurrency: 'USD',
    benchmarkCurrency: 'EUR',
  });
});
