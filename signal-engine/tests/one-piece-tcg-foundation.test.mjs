import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canEmitTcgLifecycleAlerts,
  canIngestTcgCatalogue,
  canMonitorTcgRetailers,
  getTcgCapability,
  listPublicTcgCapabilities,
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

test('One Piece catalogue shadow is enabled while monitoring and production signals remain fail-closed', () => {
  assert.deepEqual(SUPPORTED_TCG_CODES.slice(0, 3), ['pokemon', 'one-piece', 'lorcana']);
  assert.equal(getTcgCapability('one-piece')?.catalogueFoundation, true);
  assert.equal(getTcgCapability('one-piece')?.activationPhase, 'catalogue_shadow');
  assert.equal(canIngestTcgCatalogue('one-piece'), true);
  assert.equal(canMonitorTcgRetailers('one-piece'), false);
  assert.equal(canEmitTcgLifecycleAlerts('one-piece'), false);
});

test('future TCG interests are discoverable but every operational capability remains fail-closed', () => {
  const future = listPublicTcgCapabilities().filter((entry) => !['pokemon', 'one-piece'].includes(entry.code));
  assert.ok(future.length >= 2);
  for (const entry of future) {
    assert.equal(entry.interestSelectable, true);
    assert.equal(entry.activationPhase, 'foundation');
    assert.equal(entry.catalogueIngestionEnabled, false);
    assert.equal(entry.retailerMonitoringEnabled, false);
    assert.equal(entry.lifecycleAlertsEnabled, false);
  }
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
    marketCode: 'GB',
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
    marketCode: 'GB',
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
  assert.throws(
    () => adaptOnePieceCardEvidence({ ...base, marketCode: '' }, { sourceName: 'fixture' }),
    /marketCode is required/,
  );
});
