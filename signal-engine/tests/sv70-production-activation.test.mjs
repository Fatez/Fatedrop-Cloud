import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEvidence } from '../src/trader/value/sv70-production-activation-cli.mjs';
import { parseTcgdexCardSource } from '../src/trader/value/tcgdex-repository-cardmarket-evidence.mjs';
import { REVIEWED_SV_BASE_LANE } from '../src/trader/value/cardmarket-reviewed-sv-base-lane.mjs';

// Source shape reproduced from the pinned TCGdex sv01-019/240/241 files:
// explicit holo variant without its own ID, with thirdParty at the card root.
function fixture(number = '19') {
  const entry = REVIEWED_SV_BASE_LANE.find(row => row.collectorNumber === number);
  const dir = mkdtempSync(join(tmpdir(), 'sv70-evidence-'));
  const path = join(dir, entry.tcgdexCardId.split('-')[1] + '.ts');
  const source = 'const card: Card = {\n\tname: { en: ' + JSON.stringify(entry.name)
    + ' },\n\tvariants: [{type: "holo"}],\n\tthirdParty: {cardmarket: '
    + entry.sourceRecordId + '}\n}';
  writeFileSync(path, source);
  const card = parseTcgdexCardSource(path, source, 'sv01');
  const product = { name: number === '240' ? "Professor's Research - Professor Sada"
    : number === '241' ? "Professor's Research - Professor Turo" : entry.name,
    sourceExpansionId: 5223 };
  const products = new Map([[entry.sourceRecordId, product]]);
  const prices = new Map([[entry.sourceRecordId, { trend: 12 }]]);
  return { entry, card, product, products, prices, cleanup: () => rmSync(dir, { recursive: true }) };
}
test('activation accepts root product plus explicit sole holo without variant product ID', () => {
  const f = fixture();
  try {
    assert.equal(f.card.variants[0].cardmarketProductId, null);
    assert.doesNotThrow(() => verifyEvidence(f.entry, f.card, f.products, f.prices));
  } finally { f.cleanup(); }
});
test('activation rejects missing, competing and special finish evidence', () => {
  const f = fixture();
  try {
    for (const variants of [[], [...f.card.variants, { type: 'normal', stamp: [] }],
      [{...f.card.variants[0], stamp: ['prerelease']}],
      [{...f.card.variants[0], cardmarketProductId: 999}]]) {
      assert.throws(() => verifyEvidence(f.entry, {...f.card, variants}, f.products, f.prices));
    }
    assert.throws(() => verifyEvidence({...f.entry, sourceRecordId: '999'}, f.card, f.products, f.prices), /Root Cardmarket/);
  } finally { f.cleanup(); }
});
test('Professor labels must match the exact reviewed collector number', () => {
  for (const number of ['240','241']) {
    const f = fixture(number);
    try {
      assert.doesNotThrow(() => verifyEvidence(f.entry, f.card, f.products, f.prices));
      f.product.name = "Professor's Research";
      assert.throws(() => verifyEvidence(f.entry, f.card, f.products, f.prices), /provider label/);
    } finally { f.cleanup(); }
  }
});
test('live product expansion, name and price evidence still fail closed', () => {
  const f = fixture();
  try {
    f.product.sourceExpansionId = 1;
    assert.throws(() => verifyEvidence(f.entry, f.card, f.products, f.prices));
    f.product.sourceExpansionId = 5223;
    f.product.name = 'Wrong card';
    assert.throws(() => verifyEvidence(f.entry, f.card, f.products, f.prices), /product name/);
    f.product.name = f.entry.name;
    f.prices.set(f.entry.sourceRecordId, {trend: 0});
    assert.throws(() => verifyEvidence(f.entry, f.card, f.products, f.prices), /price missing/);
  } finally { f.cleanup(); }
});
