import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewedOfficialChecklistPrinting } from '../src/trader/catalogue/official-checklist-supplements.mjs';

const setMatch = Object.freeze({
  status: 'matched',
  tcgCode: 'pokemon',
  canonicalSeriesId: 'fdseries_test',
  canonicalSetId: 'fdset_test',
  evidence: Object.freeze([
    Object.freeze({ sourceName: 'tcgdex', sourceRecordId: 'swshp' }),
    Object.freeze({ sourceName: 'pokemontcg-api', sourceRecordId: 'swshp' }),
  ]),
});

function base(sourceRecordId, name, collectorNumber) {
  return {
    sourceName: 'tcgdex',
    sourceSetCode: 'swshp',
    sourceRecordId,
    sourceUrl: `https://api.tcgdex.net/v2/en/cards/${collectorNumber}`,
    tcgCode: 'pokemon',
    languageCode: 'en',
    collectorNumber,
    printingCode: 'main',
    name,
    rarity: 'Promo',
    supertype: 'Pokémon',
  };
}

test('official Pokemon evidence completes only SWSH299 through SWSH301 checklist membership', () => {
  const records = [
    ['swshp-SWSH299', 'Jirachi V', 'SWSH299'],
    ['swshp-SWSH300', 'Unown V', 'SWSH300'],
    ['swshp-SWSH301', 'Lugia V', 'SWSH301'],
  ];
  for (const [id, name, number] of records) {
    const result = reviewedOfficialChecklistPrinting(setMatch, base(id, name, number));
    assert.ok(result, id);
    assert.equal(result.status, 'matched');
    assert.equal(result.collectorNumber, number);
    assert.equal(result.verificationBasis.kind, 'base_printing_tcgdex_official_pokemon');
    assert.equal(result.verificationBasis.sources[1].sourceName, 'pokemon-official');
    assert.match(result.verificationBasis.sources[1].sourceUrl, new RegExp(`${number}/$`));
  }
});

test('official checklist supplement fails closed on any unexpected card or source drift', () => {
  assert.equal(reviewedOfficialChecklistPrinting(setMatch, base('swshp-SWSH298', 'Miraidon ex', 'SWSH298')), null);
  assert.equal(reviewedOfficialChecklistPrinting(setMatch, base('swshp-SWSH299', 'Wrong Name', 'SWSH299')), null);
  assert.equal(reviewedOfficialChecklistPrinting(setMatch, { ...base('swshp-SWSH299', 'Jirachi V', 'SWSH299'), languageCode: 'ja' }), null);
  assert.equal(reviewedOfficialChecklistPrinting({ ...setMatch, evidence: [] }, base('swshp-SWSH299', 'Jirachi V', 'SWSH299')), null);
});
