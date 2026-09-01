import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOnePieceSealedOffer,
  onePieceProductType,
  onePieceSetCodes,
} from '../src/trader/one-piece/sealed-product-intelligence.mjs';

test('One Piece sealed identity preserves explicit set, product, language and market evidence', () => {
  const result = classifyOnePieceSealedOffer({
    retailerSku: 'fixture-op13',
    title: 'One Piece OP-13 Booster Box English UK Release',
    url: 'https://example.invalid/op13',
  }, { retailerId: 'fixture' });

  assert.equal(result.status, 'matched');
  assert.equal(result.identity.setCode, 'OP-13');
  assert.equal(result.identity.productType, 'booster_box');
  assert.equal(result.identity.languageCode, 'en');
  assert.equal(result.identity.marketCode, 'GB');
  assert.equal(result.identity.printingCode, null);
  assert.equal(result.identity.variantCode, null);
  assert.match(result.identityKey, /unknown-printing\|unknown-variant$/);
});

test('UK retailer location never invents language, market, printing or variant evidence', () => {
  const result = classifyOnePieceSealedOffer({
    retailerSku: 'fixture-op13',
    title: 'One Piece Card Game OP13 Booster Display',
    url: 'https://uk-retailer.example/op13',
  }, { retailerId: 'uk-retailer' });

  assert.equal(result.status, 'matched');
  assert.equal(result.identity.languageCode, null);
  assert.equal(result.identity.marketCode, null);
  assert.equal(result.identity.printingCode, null);
  assert.equal(result.identity.variantCode, null);
  assert.ok(result.reasons.includes('language_unresolved'));
});

test('One Piece set and product normalisation covers hyphenless codes and sealed families', () => {
  assert.deepEqual(onePieceSetCodes('One Piece OPK02 Korean booster box and ST23 Starter Deck'), ['OPK-02', 'ST-23']);
  assert.deepEqual(onePieceSetCodes('One Piece IB06 Illustration Box and TS02 Tin Pack Set'), ['IB-06', 'TS-02']);
  assert.equal(onePieceProductType('One Piece ST-23 Starter Deck'), 'starter_deck');
  assert.equal(onePieceProductType('One Piece OP-13 Booster Case'), 'booster_case');
  assert.equal(onePieceProductType('One Piece DP-07 Double Pack'), 'double_pack');
  assert.equal(onePieceProductType('One Piece IB-06 Illustration Box Vol.6'), 'illustration_box');
  assert.equal(onePieceProductType('One Piece TS-02 Tin Pack Set Vol.2'), 'tin_pack_set');
});

test('verified illustration box and tin pack sealed families stay matched without invented language', () => {
  const illustrationBox = classifyOnePieceSealedOffer({ title: 'One Piece Card Game: Illustration Box Vol.6 (IB-06)' });
  const tinPackSet = classifyOnePieceSealedOffer({ title: 'One Piece Tin Pack Set Vol.2 [TS-02]' });

  assert.equal(illustrationBox.status, 'matched');
  assert.equal(illustrationBox.identity.setCode, 'IB-06');
  assert.equal(illustrationBox.identity.productType, 'illustration_box');
  assert.equal(illustrationBox.identity.languageCode, null);
  assert.ok(illustrationBox.reasons.includes('language_unresolved'));

  assert.equal(tinPackSet.status, 'matched');
  assert.equal(tinPackSet.identity.setCode, 'TS-02');
  assert.equal(tinPackSet.identity.productType, 'tin_pack_set');
  assert.equal(tinPackSet.identity.languageCode, null);
  assert.ok(tinPackSet.reasons.includes('language_unresolved'));
});

test('conflicting set or language evidence never becomes a matched identity', () => {
  const sets = classifyOnePieceSealedOffer({ title: 'One Piece OP-13 OP-14 English Booster Box' });
  const languages = classifyOnePieceSealedOffer({ title: 'One Piece OP-13 English Japanese Booster Box' });
  assert.equal(sets.status, 'conflicting');
  assert.ok(sets.reasons.includes('conflicting_set_codes'));
  assert.equal(languages.status, 'conflicting');
  assert.ok(languages.reasons.includes('conflicting_language_evidence'));
});

test('singles, graded cards, opened products and accessories are rejected from sealed monitoring', () => {
  for (const title of [
    'One Piece OP-13 single card booster pack art',
    'One Piece OP-13 PSA graded booster pack',
    'One Piece OP-13 opened booster box',
    'One Piece OP-13 booster box sleeves accessory bundle',
  ]) {
    const result = classifyOnePieceSealedOffer({ title });
    assert.equal(result.status, 'rejected', title);
    assert.ok(result.reasons.includes('non_sealed_or_unsafe_product'), title);
  }
});

test('Korean OPK family records explicit language without guessing a release market', () => {
  const result = classifyOnePieceSealedOffer({ title: 'One Piece OPK02 Korean Booster Box' });
  assert.equal(result.status, 'matched');
  assert.equal(result.identity.setCode, 'OPK-02');
  assert.equal(result.identity.languageCode, 'ko');
  assert.equal(result.identity.marketCode, null);
});
