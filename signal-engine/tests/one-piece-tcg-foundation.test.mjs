import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canEmitTcgLifecycleAlerts,
  canIngestTcgCatalogue,
  canMonitorTcgRetailers,
  getTcgCapability,
  SUPPORTED_TCG_CODES,
} from '../src/trader/tcg-registry.mjs';
import {
  makeCanonicalCardKey,
  makeFateCardId,
} from '../src/trader/card-identity.mjs';
import {
  adaptOnePieceCardEvidence,
  adaptOnePieceSetEvidence,
} from '../src/trader/catalogue/one-piece-contract.mjs';

const sharedIdentity = Object.freeze({
  seriesCode: 'series-1',
  setCode: 'op-01',
  collectorNumber: '001',
  printingCode: 'main',
  variantCode: 'base',
  languageCode: 'en',
});

test('One Piece is registered as foundation-only and cannot emit production signals yet', () => {
  assert.deepEqual(SUPPORTED_TCG_CODES, ['pokemon', 'one-piece']);
  assert.equal(getTcgCapability('one-piece')?.catalogueFoundation, true);
  assert.equal(canIngestTcgCatalogue('one-piece'), false);
  assert.equal(canMonitorTcgRetailers('one-piece'), false);
  assert.equal(canEmitTcgLifecycleAlerts('one-piece'), false);
});

test('existing Pokémon capabilities remain enabled', () => {
  assert.equal(canIngestTcgCatalogue('pokemon'), true);
  assert.equal(canMonitorTcgRetailers('pokemon'), true);
  assert.equal(canEmitTcgLifecycleAlerts('pokemon'), true);
});

test('canonical card identity is namespaced by TCG and cannot collide across games', () => {
  const pokemon = { ...sharedIdentity, tcgCode: 'pokemon' };
  const onePiece = { ...sharedIdentity, tcgCode: 'one-piece' };

  assert.notEqual(makeCanonicalCardKey(pokemon), makeCanonicalCardKey(onePiece));
  assert.notEqual(makeFateCardId(pokemon), makeFateCardId(onePiece));
});

test('One Piece set evidence preserves explicit market-facing identity without guessing', () => {
  const evidence = adaptOnePieceSetEvidence({
    sourceRecordId: 'op01-en',
    languageCode: 'en',
    seriesName: 'Release Series',
    setName: 'Romance Dawn',
    sourceSetCode: 'OP-01',
    printedTotal: 121,
    total: 121,
    releasedAt: 1_669_939_200,
    sourceUrl: 'https://example.invalid/sets/op01',
  }, { sourceName: 'fixture', sourceVersion: 'fixture-v1' });

  assert.equal(evidence.tcgCode, 'one-piece');
  assert.equal(evidence.languageCode, 'en');
  assert.equal(evidence.sourceSetCode, 'OP-01');
  assert.equal(evidence.sourceName, 'fixture');
});

test('One Piece card evidence requires explicit language and printing and does not invent variant proof', () => {
  const base = {
    sourceRecordId: 'op01-001',
    languageCode: 'en',
    seriesName: 'Release Series',
    setName: 'Romance Dawn',
    sourceSetCode: 'OP-01',
    collectorNumber: '001',
    printingCode: 'main',
    name: 'Fixture Card',
  };

  const evidence = adaptOnePieceCardEvidence(base, { sourceName: 'fixture' });
  assert.equal(evidence.tcgCode, 'one-piece');
  assert.equal(evidence.variantEvidenceAvailable, false);

  assert.throws(
    () => adaptOnePieceCardEvidence({ ...base, languageCode: '' }, { sourceName: 'fixture' }),
    /languageCode is required/,
  );
  assert.throws(
    () => adaptOnePieceCardEvidence({ ...base, printingCode: '' }, { sourceName: 'fixture' }),
    /printingCode is required/,
  );
});
