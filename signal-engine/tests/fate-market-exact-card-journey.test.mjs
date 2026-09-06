import test from 'node:test';
import assert from 'node:assert/strict';

import { handleFateTraderCatalogue } from '../src/trader/catalogue/http.mjs';
import { handleFateCollectors } from '../src/trader/collection/collectors-http.mjs';
import { handleFateTraderCollection } from '../src/trader/collection/http.mjs';
import { handleFatePulse } from '../src/trader/value/http.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const USER = async () => ({ id: 'user_exact_journey', fateId: 'FD-EXACT' });
const FLAGS = Object.freeze({
  enabled: true,
  catalogueEnabled: true,
  collectionEnabled: true,
  collectrImportWriteEnabled: true,
});

function request(method, url, body = null) {
  const raw = body == null ? null : JSON.stringify(body);
  return {
    method,
    url,
    headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() {
      if (raw) yield Buffer.from(raw);
    },
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

function mutableStore(initialState) {
  const state = structuredClone(initialState);
  return {
    async read() { return state; },
    async mutate(operation) { return operation(state); },
  };
}

function marketDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function observation({ id, cardIdentityId, at, marketPrice, trendPrice, avg7d, avg30d }) {
  return {
    id,
    cardIdentityId,
    cardSourceMappingId: `mapping-${cardIdentityId}`,
    sourceName: 'cardmarket',
    sourceSnapshotId: `snapshot-${marketDay(at)}`,
    sourceRecordId: cardIdentityId,
    sourceVariantKey: 'standard',
    marketSegmentKey: 'standard',
    conditionCode: 'unspecified',
    currencyCode: 'EUR',
    observedAt: at,
    sourceEffectiveAt: at,
    marketDay: marketDay(at),
    marketPrice,
    trendPrice,
    avg7d,
    avg30d,
  };
}

function journeyStore(now) {
  const currentAt = now - (60 * 60 * 1000);
  const sevenDaysAgo = currentAt - (7 * DAY_MS);
  const thirtyDaysAgo = currentAt - (30 * DAY_MS);
  return mutableStore({
    traderCatalogue: {
      tcgs: { pokemon: { id: 'pokemon', code: 'pokemon', name: 'Pokémon TCG' } },
      series: { sv: { id: 'sv', tcgId: 'pokemon', code: 'sv', name: 'Scarlet & Violet', verificationStatus: 'verified' } },
      sets: { journey: { id: 'journey', tcgId: 'pokemon', seriesId: 'sv', code: 'journey', name: 'Journey Set', printedTotal: 2, total: 2, verificationStatus: 'verified' } },
      setSourceMappings: {},
      printings: {
        charizard: { id: 'charizard', name: 'Charizard', verificationStatus: 'verified' },
        blastoise: { id: 'blastoise', name: 'Blastoise', verificationStatus: 'verified' },
      },
      cards: {
        'charizard-standard': { id: 'charizard-standard', tcgId: 'pokemon', seriesId: 'sv', setId: 'journey', printingId: 'charizard', collectorNumber: '1', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified', verifiedAt: now },
        'blastoise-standard': { id: 'blastoise-standard', tcgId: 'pokemon', seriesId: 'sv', setId: 'journey', printingId: 'blastoise', collectorNumber: '2', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified', verifiedAt: now },
      },
      cardSourceMappings: {},
      cardProvenance: {},
    },
    fateValueLab: {
      ingestRuns: {},
      rejections: {},
      observations: {
        charizard30: observation({ id: 'charizard30', cardIdentityId: 'charizard-standard', at: thirtyDaysAgo, marketPrice: 8, trendPrice: 7, avg7d: 8, avg30d: 8 }),
        charizard7: observation({ id: 'charizard7', cardIdentityId: 'charizard-standard', at: sevenDaysAgo, marketPrice: 10, trendPrice: 8, avg7d: 10, avg30d: 10 }),
        charizardNow: observation({ id: 'charizardNow', cardIdentityId: 'charizard-standard', at: currentAt, marketPrice: 20, trendPrice: 10, avg7d: 20, avg30d: 20 }),
        blastoise30: observation({ id: 'blastoise30', cardIdentityId: 'blastoise-standard', at: thirtyDaysAgo, marketPrice: 24, trendPrice: 24, avg7d: 24, avg30d: 24 }),
        blastoise7: observation({ id: 'blastoise7', cardIdentityId: 'blastoise-standard', at: sevenDaysAgo, marketPrice: 20, trendPrice: 20, avg7d: 20, avg30d: 20 }),
        blastoiseNow: observation({ id: 'blastoiseNow', cardIdentityId: 'blastoise-standard', at: currentAt, marketPrice: 16, trendPrice: 16, avg7d: 16, avg30d: 16 }),
      },
    },
    traderCollection: {
      collections: {},
      items: {},
      grading: {},
      media: {},
      wants: {},
      events: [],
      itemSources: {},
    },
  });
}

test('exact discovery flows through FatePrice, manual/import ownership, binder and personal Pulse', async () => {
  const store = journeyStore(Date.now());

  const track = response();
  await handleFateCollectors(
    request('PUT', '/v1/collectors/binders/journey'),
    track,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(track.status, 200);
  assert.equal(track.body.data.binder.tracked, true);

  const emptyBinder = response();
  await handleFateCollectors(
    request('GET', '/v1/collectors/summary?currency=EUR&language=en&variant=standard'),
    emptyBinder,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(emptyBinder.status, 200);
  assert.equal(emptyBinder.body.data.summary.sets[0].ownedCount, 0);
  assert.equal(emptyBinder.body.data.summary.sets[0].explicitlyTracked, true);

  const discovery = response();
  await handleFateTraderCatalogue(
    request('GET', '/v1/fate-price/cards?q=Charizard'),
    discovery,
    { store, flags: FLAGS },
  );
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.data.count, 1);
  const exactCardId = discovery.body.data.cards[0].id;
  assert.equal(exactCardId, 'charizard-standard');

  const fatePrice = response();
  await handleFateTraderCatalogue(
    request('GET', `/v1/fate-price/${exactCardId}`),
    fatePrice,
    { store, flags: FLAGS },
  );
  assert.equal(fatePrice.status, 200);
  assert.equal(fatePrice.body.data.fatePrice.available, true);
  assert.equal(fatePrice.body.data.fatePrice.price.amount, 20);
  assert.equal(fatePrice.body.data.fatePrice.movement.d7.percent, 100);
  assert.equal(fatePrice.body.data.fatePrice.movementPolicy.policyVersion, 'fate-price-v1');

  const add = response();
  await handleFateTraderCollection(
    request('POST', '/v1/collection/items', { fateCardId: exactCardId, quantity: 1, copyState: 'raw', conditionCode: 'near_mint' }),
    add,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(add.status, 201);
  assert.equal(add.body.data.item.fateCardId, exactCardId);

  const increaseQuantity = response();
  await handleFateTraderCollection(
    request('PATCH', `/v1/collection/items/${add.body.data.item.id}`, { quantity: 3, expectedRevision: add.body.data.item.revision }),
    increaseQuantity,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(increaseQuantity.status, 200);
  assert.equal(increaseQuantity.body.data.item.quantity, 3);

  const csvText = 'Game,Set,Name,Card Number,Variant,Condition,Quantity\nPokémon,Journey Set,Blastoise,2,Normal,NM,1';
  const preview = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/import/collectr/preview', { csvText }),
    preview,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.preview.matched.exact, 1);

  const confirm = response();
  await handleFateCollectors(
    request('POST', '/v1/collectors/import/collectr/confirm', { csvText, confirmationToken: preview.body.data.confirmationToken, confirmed: true }),
    confirm,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.summary.created, 1);

  const pulse = response();
  await handleFatePulse(request('GET', '/v1/market/pulse?tcg=pokemon'), pulse, { store });
  assert.equal(pulse.status, 200);
  assert.equal(pulse.body.data.source.priceField, 'fatePrice');
  assert.equal(pulse.body.data.source.movementPolicy.policyVersion, 'fate-price-v1');
  assert.equal(pulse.body.data.source.movementPolicy.baselinePolicy, 'exact_market_day_no_substitution');
  assert.equal(pulse.body.data.pulse.direction.periods.d7.cardRisers[0].movementPercent, 100);

  const collector = response();
  await handleFateCollectors(
    request('GET', '/v1/collectors/summary?currency=EUR&language=en&variant=standard'),
    collector,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(collector.status, 200);
  assert.equal(collector.body.data.summary.cardUnits, 4);
  assert.equal(collector.body.data.summary.collection.totalValue, 76);
  assert.equal(collector.body.data.summary.collection.priceCoveragePercent, 100);
  assert.equal(collector.body.data.summary.sets[0].ownedCount, 2);
  assert.equal(collector.body.data.summary.sets[0].completionPercent, 100);
  assert.equal(collector.body.data.evidence.exactCollectionValuesConnected, true);
  assert.equal(collector.body.data.evidence.completeSetValuesConnected, false);
  assert.equal(collector.body.data.evidence.personalPulseConnected, true);
  assert.equal(collector.body.data.personalPulse.movementPolicy.policyVersion, 'fate-price-v1');
  assert.equal(collector.body.data.personalPulse.movementPolicy.baselinePolicy, 'latest_on_or_before_target_within_3_days');
  assert.equal(collector.body.data.personalPulse.periods.d7.risers[0].cardIdentityId, exactCardId);
  assert.equal(collector.body.data.personalPulse.periods.d7.risers[0].movementPercent, 100);
  assert.equal(collector.body.data.personalPulse.periods.d7.decliners[0].cardIdentityId, 'blastoise-standard');
  assert.equal(collector.body.data.personalPulse.periods.d7.setRisers[0].setId, 'journey');

  const intelligence = response();
  await handleFateCollectors(
    request('GET', '/v1/collectors/intelligence?currency=EUR'),
    intelligence,
    { store, flags: FLAGS, resolveUser: USER },
  );
  assert.equal(intelligence.status, 200);
  assert.equal(intelligence.body.data.scope, 'owned_raw_cards_only');
  assert.equal(intelligence.body.data.snapshot.currentKnownValue, 76);
  assert.equal(intelligence.body.data.snapshot.totalCopies, 4);
  assert.equal(intelligence.body.data.cards.length, 2);
  assert.equal(intelligence.body.data.cards.find((row) => row.cardIdentityId === exactCardId).quantity, 3);
  assert.equal(intelligence.body.data.snapshot.topFiveValue, 76);
  assert.equal(intelligence.body.data.sets[0].setId, 'journey');
  assert.equal(intelligence.body.data.history.pointPolicy, 'stored_market_days_only_no_interpolation');
});
