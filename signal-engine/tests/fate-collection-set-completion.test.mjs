import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleFateCollectors } from '../src/trader/collection/collectors-http.mjs';
import { handleFateTraderCollection } from '../src/trader/collection/http.mjs';

const USER = async () => ({ id: 'user-complete', fateId: 'FD-COMPLETE' });
const FLAGS = Object.freeze({ enabled: true, catalogueEnabled: true, collectionEnabled: true });

function request(method, url, body = null) {
  const raw = body == null ? null : JSON.stringify(body);
  return {
    method,
    url,
    headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); },
  };
}

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(raw) { this.body = JSON.parse(raw); },
  };
}

function store({ declaredTotal = 2 } = {}) {
  const state = {
    traderCatalogue: {
      tcgs: { pokemon: { id: 'pokemon', code: 'pokemon', name: 'Pokémon TCG' } },
      series: { sv: { id: 'sv', tcgId: 'pokemon', name: 'Scarlet & Violet', verificationStatus: 'verified' } },
      sets: {
        complete: {
          id: 'complete',
          tcgId: 'pokemon',
          seriesId: 'sv',
          name: 'Complete Me',
          printedTotal: declaredTotal,
          total: declaredTotal,
          verificationStatus: 'verified',
        },
      },
      printings: {
        p1: { id: 'p1', name: 'One', rarity: 'Common', verificationStatus: 'verified' },
        p2: { id: 'p2', name: 'Two', rarity: 'Rare', verificationStatus: 'verified' },
      },
      cards: {
        c1: { id: 'c1', tcgId: 'pokemon', seriesId: 'sv', setId: 'complete', printingId: 'p1', collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified' },
        c1r: { id: 'c1r', tcgId: 'pokemon', seriesId: 'sv', setId: 'complete', printingId: 'p1', collectorNumber: '1', variantCode: 'reverse-holo', languageCode: 'en', verificationStatus: 'verified' },
        c2: { id: 'c2', tcgId: 'pokemon', seriesId: 'sv', setId: 'complete', printingId: 'p2', collectorNumber: '2', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified' },
      },
      setSourceMappings: {},
      cardSourceMappings: {},
      cardProvenance: {},
    },
    traderCollection: {
      collections: {},
      items: {},
      grading: {},
      media: {},
      wants: {},
      events: [],
    },
    fateValueLab: { ingestRuns: {}, rejections: {}, observations: {} },
  };
  return {
    async read() { return state; },
    async mutate(operation) { return operation(state); },
  };
}

test('preview and confirm complete a binder without creating exact cards or value evidence', async () => {
  const subject = store();
  const preview = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/sets/complete/complete/preview?language=en&variant=standard'),
    preview,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.action.printingCount, 2);
  assert.equal(preview.body.data.action.createsExactCardItems, false);
  assert.equal(preview.body.data.action.changesCollectionValue, false);
  assert.equal(preview.body.data._plan, undefined);

  const confirm = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/sets/complete/complete/confirm', {
      confirmationToken: preview.body.data.confirmationToken,
      confirmed: true,
    }),
    confirm,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.writesPerformed, true);
  assert.equal(confirm.body.data.progress.completionPercent, 100);
  assert.equal(confirm.body.data.progress.exactOwnedCount, 0);
  assert.equal(confirm.body.data.progress.exactIdentityConfirmationNeededCount, 2);

  const collection = response();
  await handleFateTraderCollection(
    request('GET', '/v1/collection'),
    collection,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(collection.status, 200);
  assert.equal(collection.body.data.summary.totalCopies, 0);
  assert.deepEqual(collection.body.data.items, []);

  const progress = response();
  await handleFateCollectors(
    request('GET', '/v1/collectors/sets/complete/progress?currency=GBP'),
    progress,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(progress.status, 200);
  assert.equal(progress.body.data.progress.ownedCount, 2);
  assert.equal(progress.body.data.progress.hasUserCompletionAssertion, true);

  const duplicate = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/sets/complete/complete/confirm', {
      confirmationToken: preview.body.data.confirmationToken,
      confirmed: true,
    }),
    duplicate,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.data.duplicate, true);
  assert.equal(duplicate.body.data.writesPerformed, false);

  const remove = response();
  await handleFateCollectors(
    request('DELETE', '/v1/collectors/sets/complete/complete'),
    remove,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(remove.status, 200);
  assert.equal(remove.body.data.removed, true);
  assert.equal(remove.body.data.progress.completionPercent, 0);
});

test('confirmation is stale when exact binder state changes after preview', async () => {
  const subject = store();
  const preview = response();
  await handleFateCollectors(request('POST', '/v1/collectors/sets/complete/complete/preview'), preview, { store: subject, flags: FLAGS, resolveUser: USER });
  const state = await subject.read();
  state.traderCollection.collections.mine = { id: 'mine', userId: 'user-complete', tcgId: 'pokemon' };
  state.traderCollection.items.owned = { id: 'owned', collectionId: 'mine', fateCardId: 'c1', quantity: 1, copyState: 'raw', status: 'active' };

  const confirm = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/sets/complete/complete/confirm', { confirmationToken: preview.body.data.confirmationToken, confirmed: true }),
    confirm,
    { store: subject, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error.code, 'SET_COMPLETION_PREVIEW_CHANGED');
});

test('incomplete canonical catalogue cannot be user-confirmed as a complete set', async () => {
  const preview = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/sets/complete/complete/preview'),
    preview,
    { store: store({ declaredTotal: 3 }), flags: FLAGS, resolveUser: USER },
  );
  assert.equal(preview.status, 409);
  assert.equal(preview.body.error.code, 'SET_CHECKLIST_UNAVAILABLE');
});

test('set-completion migration stores assertions separately from exact card ownership', async () => {
  const migration = await readFile(new URL('../database/2026-09-07-fate-collection-set-completion.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_collection_set_completion_assertions/);
  assert.match(migration, /printing_ids JSONB/);
  assert.match(migration, /source = 'user_confirmed_checklist'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_collection_set_completion_events/);
  assert.doesNotMatch(migration, /INSERT INTO fatedrop_collection_items/i);
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/im);
});
