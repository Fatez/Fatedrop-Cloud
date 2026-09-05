import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditExplicitCardmarketMappings,
  indexCardmarketProducts,
  loadTcgdexRepositoryEvidence,
  parseTcgdexCardSource,
  parseTcgdexSetSource,
} from '../src/trader/value/tcgdex-repository-cardmarket-evidence.mjs';

const setSource = `import { Set } from '../../interfaces'\nconst set: Set = {\n id: "sv03.5",\n name: { en: "151" },\n cardCount: { official: 165 },\n releaseDate: "2023-09-22",\n abbreviations: { official: "MEW" },\n thirdParty: { cardmarket: 5402 }\n}`;
const cardSource = `import { Card } from '../../../interfaces'\nconst card: Card = {\n name: { en: "Bulbasaur" },\n variants: [\n  { type: 'normal', thirdParty: { cardmarket: 733596 } },\n  { type: 'reverse', thirdParty: { cardmarket: 733596 } },\n  { type: 'normal', stamp: ['set-logo'], thirdParty: { cardmarket: 720365 } },\n  { type: 'reverse', foil: 'cosmos', thirdParty: { cardmarket: 794908 } }\n ]\n}`;

test('parses explicit Cardmarket expansion and variant product ids from TCGdex repository sources', () => {
  const root = path.join('/tmp', 'data');
  const set = parseTcgdexSetSource(path.join(root, 'Scarlet & Violet', '151.ts'), setSource, root);
  assert.equal(set.tcgdexSetId, 'sv03.5');
  assert.equal(set.setName, '151');
  assert.equal(set.cardmarketExpansionId, 5402);
  assert.equal(set.officialAbbreviation, 'MEW');

  const card = parseTcgdexCardSource(path.join(root, 'Scarlet & Violet', '151', '001.ts'), cardSource, set.tcgdexSetId);
  assert.equal(card.tcgdexCardId, 'sv03.5-001');
  assert.equal(card.name, 'Bulbasaur');
  assert.deepEqual(card.variants.map((row) => row.cardmarketProductId), [733596, 733596, 720365, 794908]);
  assert.deepEqual(card.variants[2].stamp, ['set-logo']);
});

test('repository loader joins set metadata to its card directory without network calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgdex-evidence-'));
  const data = path.join(root, 'data', 'Scarlet & Violet');
  fs.mkdirSync(path.join(data, '151'), { recursive: true });
  fs.writeFileSync(path.join(data, '151.ts'), setSource);
  fs.writeFileSync(path.join(data, '151', '001.ts'), cardSource);
  const evidence = loadTcgdexRepositoryEvidence(root);
  assert.equal(evidence.setCount, 1);
  assert.equal(evidence.sets[0].cards.length, 1);
  assert.equal(evidence.sets[0].cards[0].localId, '001');
});

test('explicit product ids accept Cardmarket provider-only disambiguation suffixes without weakening the base-name check', () => {
  const set = {
    tcgdexSetId: 'sv03.5',
    setName: '151',
    cardmarketExpansionId: 5402,
    officialCardCount: 165,
    cards: [parseTcgdexCardSource('/tmp/001.ts', cardSource, 'sv03.5')],
  };
  const products = [
    { sourceRecordId: '733596', sourceExpansionId: 5402, name: 'Bulbasaur [Leech Seed | 151]' },
    { sourceRecordId: '720365', sourceExpansionId: 5328, name: 'Bulbasaur' },
    { sourceRecordId: '794908', sourceExpansionId: 5700, name: 'Bulbasaur [Leech Seed]' },
  ];
  const index = indexCardmarketProducts(products);
  const audit = auditExplicitCardmarketMappings(set, index.byId, index.byExpansion);
  assert.equal(audit.status, 'proven');
  assert.equal(audit.cardmarketExpansionId, 5402);
  assert.equal(audit.counts.cardsWithVerifiedProduct, 1);
  assert.equal(audit.counts.missingProducts, 0);
  assert.equal(audit.counts.nameConflicts, 0);
  assert.ok(audit.mappings.some((row) => row.expansionRelation === 'supplemental_cardmarket_expansion'));
  assert.equal(audit.mappings.find((row) => row.cardmarketProductId === 733596)?.nameMatchBasis, 'provider_disambiguation_suffix');
  assert.equal(audit.mappings.find((row) => row.cardmarketProductId === 720365)?.nameMatchBasis, 'exact_name');
});

test('Cardmarket Nidoran gender aliases stay distinct while provider descriptors are removed', () => {
  const nidoranSource = `import { Card } from '../../../interfaces'\nconst card: Card = {\n name: { en: "Nidoran♀" },\n variants: [\n  { type: 'normal', thirdParty: { cardmarket: 733624 } }\n ]\n}`;
  const set = {
    tcgdexSetId: 'sv03.5',
    setName: '151',
    cardmarketExpansionId: 5402,
    officialCardCount: 165,
    cards: [parseTcgdexCardSource('/tmp/029.ts', nidoranSource, 'sv03.5')],
  };
  const products = [
    { sourceRecordId: '733624', sourceExpansionId: 5402, name: 'Nidoran [F] [Poison Horn]' },
  ];
  const index = indexCardmarketProducts(products);
  const audit = auditExplicitCardmarketMappings(set, index.byId, index.byExpansion);
  assert.equal(audit.counts.cardsWithVerifiedProduct, 1);
  assert.equal(audit.counts.nameConflicts, 0);
  assert.equal(audit.mappings[0].nameMatchBasis, 'provider_disambiguation_suffix');
});

test('provider suffix handling still rejects a different base card name', () => {
  const set = {
    tcgdexSetId: 'sv03.5',
    setName: '151',
    cardmarketExpansionId: 5402,
    officialCardCount: 165,
    cards: [parseTcgdexCardSource('/tmp/001.ts', cardSource, 'sv03.5')],
  };
  const products = [
    { sourceRecordId: '733596', sourceExpansionId: 5402, name: 'Ivysaur [Leech Seed]' },
    { sourceRecordId: '720365', sourceExpansionId: 5328, name: 'Bulbasaur' },
    { sourceRecordId: '794908', sourceExpansionId: 5700, name: 'Bulbasaur' },
  ];
  const index = indexCardmarketProducts(products);
  const audit = auditExplicitCardmarketMappings(set, index.byId, index.byExpansion);
  assert.equal(audit.counts.nameConflicts, 2);
  assert.ok(audit.mappings.filter((row) => row.cardmarketProductId === 733596).every((row) => row.status === 'conflict'));
});
