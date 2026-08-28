import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVerifiedExactSetSourceMapping } from '../src/trader/value/set-source-mapping-resolver.mjs';

function fileStore({ setStatus = 'verified', tcgCode = 'pokemon' } = {}) {
  return {
    async read() {
      return {
        traderCatalogue: {
          tcgs: { fdtcg: { id: 'fdtcg', code: tcgCode } },
          sets: { fdset: { id: 'fdset', tcgId: 'fdtcg', verificationStatus: setStatus } },
          setSourceMappings: {
            'cardmarket|777': {
              id: 'fdsetmap_cardmarket_777',
              setId: 'fdset',
              sourceName: 'cardmarket',
              sourceRecordId: '777',
            },
          },
        },
      };
    },
  };
}

test('file resolver returns only exact mappings to verified Pokémon sets', async () => {
  const resolved = await resolveVerifiedExactSetSourceMapping(fileStore(), {
    sourceName: 'cardmarket',
    sourceRecordId: '777',
    tcgCode: 'pokemon',
  });

  assert.deepEqual(resolved, {
    id: 'fdsetmap_cardmarket_777',
    setId: 'fdset',
    sourceName: 'cardmarket',
    sourceRecordId: '777',
  });

  assert.equal(await resolveVerifiedExactSetSourceMapping(fileStore({ setStatus: 'staged' }), {
    sourceName: 'cardmarket', sourceRecordId: '777', tcgCode: 'pokemon',
  }), null);
  assert.equal(await resolveVerifiedExactSetSourceMapping(fileStore({ tcgCode: 'magic' }), {
    sourceName: 'cardmarket', sourceRecordId: '777', tcgCode: 'pokemon',
  }), null);
  assert.equal(await resolveVerifiedExactSetSourceMapping(fileStore(), {
    sourceName: 'cardmarket', sourceRecordId: '778', tcgCode: 'pokemon',
  }), null);
});

test('Postgres resolver uses a read-only exact mapping query', async () => {
  const queries = [];
  const store = {
    async pool() {
      return {
        async query(sql, values) {
          queries.push({ sql, values });
          return { rows: [{
            id: 'fdsetmap_cardmarket_777',
            set_id: 'fdset',
            source_name: 'cardmarket',
            source_record_id: '777',
          }] };
        },
      };
    },
  };

  const resolved = await resolveVerifiedExactSetSourceMapping(store, {
    sourceName: 'cardmarket', sourceRecordId: '777', tcgCode: 'pokemon',
  });

  assert.equal(resolved.setId, 'fdset');
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql.trim(), /^SELECT/);
  assert.deepEqual(queries[0].values, ['cardmarket', '777', 'pokemon']);
  assert.match(queries[0].sql, /s\.verification_status='verified'/);
});
