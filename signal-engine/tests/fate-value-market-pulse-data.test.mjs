import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketPulseSnapshotFromStore,
  loadMarketPulseEvidence,
} from '../src/trader/value/market-pulse-data.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

function card({
  id = 'card_p1',
  tcgId = 'tcg_pokemon',
  seriesId = 'series_sv',
  setId = 'set_sv08',
  printingId = 'printing_p1',
  verificationStatus = 'verified',
} = {}) {
  return {
    id,
    tcgId,
    seriesId,
    setId,
    printingId,
    collectorNumber: '57',
    variantCode: 'normal',
    languageCode: 'en',
    verificationStatus,
  };
}

function observation({
  id,
  cardIdentityId = 'card_p1',
  day,
  trendPrice,
  sourceName = 'cardmarket',
  currencyCode = 'EUR',
  marketSegmentKey = 'default',
  conditionCode = 'unspecified',
} = {}) {
  return {
    id: id ?? `${cardIdentityId}-${day}`,
    cardIdentityId,
    sourceName,
    sourceSnapshotId: `prices-${day}`,
    sourceRecordId: cardIdentityId,
    sourceVariantKey: 'normal',
    marketSegmentKey,
    conditionCode,
    currencyCode,
    marketDay: day,
    observedAt: Date.parse(`${day}T08:00:00.000Z`),
    sourceEffectiveAt: Date.parse(`${day}T00:00:00.000Z`),
    trendPrice,
  };
}

function fileState() {
  return {
    traderCatalogue: {
      tcgs: {
        tcg_pokemon: { id: 'tcg_pokemon', code: 'pokemon' },
        tcg_one_piece: { id: 'tcg_one_piece', code: 'one-piece' },
      },
      series: {
        series_sv: { id: 'series_sv', code: 'scarlet-violet' },
        series_op: { id: 'series_op', code: 'one-piece-card-game' },
      },
      sets: {
        set_sv08: { id: 'set_sv08', code: 'sv08', name: 'Surging Sparks', printedTotal: 1, total: 1 },
        set_op09: { id: 'set_op09', code: 'op09', name: 'Emperors in the New World', printedTotal: 1, total: 1 },
      },
      printings: {
        printing_p1: { id: 'printing_p1', name: 'Pikachu' },
        printing_op1: { id: 'printing_op1', name: 'Monkey.D.Luffy' },
      },
      cards: {
        card_p1: card(),
        card_op1: card({
          id: 'card_op1',
          tcgId: 'tcg_one_piece',
          seriesId: 'series_op',
          setId: 'set_op09',
          printingId: 'printing_op1',
        }),
        card_unverified: card({ id: 'card_unverified', verificationStatus: 'staged' }),
      },
    },
    fateValueLab: {
      observations: {
        p_now: observation({ id: 'p_now', day: '2026-09-03', trendPrice: 110 }),
        p_7d: observation({ id: 'p_7d', day: '2026-08-27', trendPrice: 100 }),
        op_now: observation({ id: 'op_now', cardIdentityId: 'card_op1', day: '2026-09-03', trendPrice: 120 }),
        ignored_currency: observation({ id: 'ignored_currency', day: '2026-09-03', trendPrice: 999, currencyCode: 'GBP' }),
        old: observation({ id: 'old', day: '2026-07-01', trendPrice: 1 }),
        unverified: observation({ id: 'unverified', cardIdentityId: 'card_unverified', day: '2026-09-03', trendPrice: 500 }),
      },
    },
  };
}

const basis = {
  sourceName: 'cardmarket',
  priceField: 'trendPrice',
  currencyCode: 'EUR',
};

test('file bridge resolves canonical TCG, series and set codes without mutating the store', async () => {
  const state = fileState();
  const before = structuredClone(state);
  const store = { read: async () => state };

  const result = await loadMarketPulseEvidence(store, basis);

  assert.equal(result.sourceType, 'file');
  assert.equal(result.anchorMarketDay, '2026-09-03');
  assert.equal(result.observations.some((item) => item.id === 'old'), false);
  assert.equal(result.observations.some((item) => item.id === 'ignored_currency'), false);

  const pokemon = result.cardIdentities.find((item) => item.id === 'card_p1');
  const onePiece = result.cardIdentities.find((item) => item.id === 'card_op1');
  assert.deepEqual(
    {
      tcg: pokemon.tcgCode,
      series: pokemon.seriesCode,
      set: pokemon.setCode,
      setName: pokemon.setName,
      expected: pokemon.expectedCardCount,
      name: pokemon.name,
    },
    {
      tcg: 'pokemon',
      series: 'scarlet-violet',
      set: 'sv08',
      setName: 'Surging Sparks',
      expected: 1,
      name: 'Pikachu',
    },
  );
  assert.equal(onePiece.tcgCode, 'one-piece');
  assert.equal(result.cardIdentities.some((item) => item.id === 'card_unverified'), false);
  assert.deepEqual(state, before);
});

test('one read-side call carries persisted history into the Market Pulse snapshot', async () => {
  const store = { read: async () => fileState() };
  const result = await buildMarketPulseSnapshotFromStore(store, { ...basis, generatedAt: NOW });

  assert.equal(result.schemaVersion, 'market-pulse:1a');
  assert.equal(result.evidenceSourceType, 'file');
  assert.equal(result.anchorMarketDay, '2026-09-03');
  assert.equal(result.games.length, 2);

  const pikachu = result.cards.find((item) => item.cardIdentityId === 'card_p1');
  assert.deepEqual(pikachu.movement.d7, { amount: 10, percent: 10 });
  assert.equal(result.evidence.unresolvedIdentityCount, 1);
});

test('file bridge honours TCG and set scope using canonical identity rather than provider labels', async () => {
  const store = { read: async () => fileState() };
  const result = await buildMarketPulseSnapshotFromStore(store, {
    ...basis,
    tcgCode: 'pokemon',
    setCode: 'sv08',
    generatedAt: NOW,
  });

  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].tcgCode, 'pokemon');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].setCode, 'sv08');
  assert.deepEqual(result.cards.map((item) => item.cardIdentityId), ['card_p1']);
});

test('unsupported price fields fail before any store read', async () => {
  let reads = 0;
  const store = { read: async () => { reads += 1; return fileState(); } };

  await assert.rejects(
    loadMarketPulseEvidence(store, { ...basis, priceField: 'magicAiPrice' }),
    /priceField must be one of/,
  );
  assert.equal(reads, 0);
});

test('postgres bridge performs SELECT-only reads and returns canonical joined evidence', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) return { rows: [{ anchor_market_day: '2026-09-03' }] };
      return {
        rows: [
          {
            id: 'obs-now',
            ingest_run_id: 'run-now',
            card_identity_id: 'card_p1',
            card_source_mapping_id: 'map-p1',
            source_name: 'cardmarket',
            source_snapshot_id: 'prices-2026-09-03',
            source_record_id: '123',
            source_variant_key: 'normal',
            market_segment_key: 'default',
            condition_code: 'unspecified',
            currency_code: 'EUR',
            observed_at: String(Date.parse('2026-09-03T08:00:00.000Z')),
            source_effective_at: String(Date.parse('2026-09-03T00:00:00.000Z')),
            market_day: '2026-09-03',
            market_price: null,
            low_price: '100.00',
            trend_price: '110.00',
            avg_1d: null,
            avg_7d: '105.00',
            avg_30d: '95.00',
            avg_lifetime: null,
            excellent_plus_low: null,
            collector_number: '57',
            variant_code: 'normal',
            language_code: 'en',
            verification_status: 'verified',
            tcg_code: 'pokemon',
            series_code: 'scarlet-violet',
            set_code: 'sv08',
            set_name: 'Surging Sparks',
            set_printed_total: '252',
            set_total: '252',
            card_name: 'Pikachu',
          },
        ],
      };
    },
  };
  const store = { pool: async () => pool };

  const result = await loadMarketPulseEvidence(store, { ...basis, tcgCode: 'pokemon' });

  assert.equal(result.sourceType, 'postgres');
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].trendPrice, '110.00');
  assert.equal(result.cardIdentities[0].tcgCode, 'pokemon');
  assert.equal(result.cardIdentities[0].setCode, 'sv08');
  assert.equal(result.cardIdentities[0].setName, 'Surging Sparks');
  assert.equal(result.cardIdentities[0].expectedCardCount, 252);
  assert.equal(queries.length, 2);
  for (const { sql } of queries) {
    assert.match(sql.trim(), /^SELECT/i);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
  }
  assert.match(queries[1].sql, /INTERVAL '30 days'/);
  assert.match(queries[1].sql, /JOIN fatedrop_tcgs/);
  assert.match(queries[1].sql, /JOIN fatedrop_card_sets/);
});

test('postgres bridge stops after the anchor query when no canonical market evidence exists', async () => {
  let queryCount = 0;
  const store = {
    pool: async () => ({
      async query(sql) {
        queryCount += 1;
        assert.match(sql.trim(), /^SELECT/i);
        return { rows: [{ anchor_market_day: null }] };
      },
    }),
  };

  const result = await loadMarketPulseEvidence(store, basis);
  assert.equal(queryCount, 1);
  assert.equal(result.anchorMarketDay, null);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.cardIdentities, []);
});
