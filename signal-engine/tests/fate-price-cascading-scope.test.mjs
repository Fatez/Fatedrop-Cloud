import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFateTraderCatalogue, isFateTraderCataloguePath } from '../src/trader/catalogue/http.mjs';

function responseRecorder() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

const darkFlags = Object.freeze({
  enabled: false,
  catalogueEnabled: false,
  collectionEnabled: false,
  binderEnabled: false,
  networkEnabled: false,
  matchingEnabled: false,
  huntsEnabled: false,
  messagingEnabled: false,
  trustEnabled: false,
  safeExchangeEnabled: false,
});

function scopedStore() {
  return {
    async read() {
      return {
        traderCatalogue: {
          tcgs: {
            pokemon: { id: 'pokemon', code: 'pokemon', name: 'Pokémon TCG' },
            onepiece: { id: 'onepiece', code: 'one-piece', name: 'One Piece Card Game' },
          },
          series: {
            sv: { id: 'sv', tcgId: 'pokemon', name: 'Scarlet & Violet', verificationStatus: 'verified' },
            swsh: { id: 'swsh', tcgId: 'pokemon', name: 'Sword & Shield', verificationStatus: 'verified' },
            op: { id: 'op', tcgId: 'onepiece', name: 'One Piece', verificationStatus: 'verified' },
          },
          sets: {
            mew: { id: 'mew', tcgId: 'pokemon', seriesId: 'sv', name: '151', releasedAt: 3, verificationStatus: 'verified' },
            cri: { id: 'cri', tcgId: 'pokemon', seriesId: 'swsh', name: 'Chilling Reign', releasedAt: 2, verificationStatus: 'verified' },
            op01: { id: 'op01', tcgId: 'onepiece', seriesId: 'op', name: 'Romance Dawn', releasedAt: 1, verificationStatus: 'verified' },
          },
          printings: {
            charizard: { id: 'charizard', name: 'Charizard ex', verificationStatus: 'verified' },
            pikachu: { id: 'pikachu', name: 'Pikachu', verificationStatus: 'verified' },
            luffy: { id: 'luffy', name: 'Monkey D. Luffy', verificationStatus: 'verified' },
          },
          cards: {
            card_charizard: { id: 'card_charizard', tcgId: 'pokemon', seriesId: 'sv', setId: 'mew', printingId: 'charizard', collectorNumber: '199', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified' },
            card_pikachu: { id: 'card_pikachu', tcgId: 'pokemon', seriesId: 'swsh', setId: 'cri', printingId: 'pikachu', collectorNumber: '49', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified' },
            card_luffy: { id: 'card_luffy', tcgId: 'onepiece', seriesId: 'op', setId: 'op01', printingId: 'luffy', collectorNumber: '024', variantCode: 'standard', languageCode: 'en', verificationStatus: 'verified' },
          },
          setSourceMappings: {},
          cardSourceMappings: {},
          cardProvenance: {},
        },
      };
    },
  };
}

async function get(url) {
  const res = responseRecorder();
  await handleFateTraderCatalogue(
    { method: 'GET', url, headers: { host: 'localhost' } },
    res,
    { store: scopedStore(), flags: darkFlags },
  );
  return res;
}

test('FatePrice series and sets are first-class routes while Trader is dark', async () => {
  assert.equal(isFateTraderCataloguePath('/v1/fate-price/series'), true);
  assert.equal(isFateTraderCataloguePath('/v1/fate-price/sets'), true);

  const series = await get('/v1/fate-price/series?tcg=pokemon');
  assert.equal(series.status, 200);
  assert.deepEqual(series.body.data.series.map((row) => row.id), ['sv', 'swsh']);

  const sets = await get('/v1/fate-price/sets?tcg=pokemon&seriesId=sv');
  assert.equal(sets.status, 200);
  assert.deepEqual(sets.body.data.sets.map((row) => row.id), ['mew']);
});

test('FatePrice card discovery preserves every active scope', async () => {
  const tcg = await get('/v1/fate-price/cards?tcg=pokemon');
  assert.equal(tcg.status, 200);
  assert.deepEqual(tcg.body.data.cards.map((card) => card.id), ['card_pikachu', 'card_charizard']);

  const series = await get('/v1/fate-price/cards?tcg=pokemon&seriesId=sv');
  assert.equal(series.status, 200);
  assert.deepEqual(series.body.data.cards.map((card) => card.id), ['card_charizard']);

  const set = await get('/v1/fate-price/cards?tcg=pokemon&seriesId=sv&setId=mew');
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.cards.map((card) => card.id), ['card_charizard']);

  const query = await get('/v1/fate-price/cards?tcg=pokemon&seriesId=sv&setId=mew&q=char');
  assert.equal(query.status, 200);
  assert.deepEqual(query.body.data.cards.map((card) => card.id), ['card_charizard']);
});

test('incompatible downstream scope fails closed to zero cards', async () => {
  const res = await get('/v1/fate-price/cards?tcg=pokemon&seriesId=sv&setId=cri');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.count, 0);
});

test('blank card discovery is allowed only when at least one scope exists', async () => {
  const blank = await get('/v1/fate-price/cards');
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.code, 'FATE_PRICE_CARD_FILTER_REQUIRED');

  const scoped = await get('/v1/fate-price/cards?seriesId=sv');
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.data.count, 1);
});
