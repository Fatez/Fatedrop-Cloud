import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeArtworkBackfill } from '../src/trader/catalogue/backfill-printing-artwork.mjs';

function mockDb({ total, withThumbnail, missingIds = [], candidateRows = [] }) {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes('COUNT(*)::int AS total')) {
        return { rows: [{ total, with_thumbnail: withThumbnail }] };
      }
      if (text.includes('SELECT id,set_id,collector_number,name')) {
        return { rows: missingIds.map((id) => ({ id, set_id: 's', collector_number: id, name: id })) };
      }
      if (text.includes('SELECT id, attributes')) {
        return { rows: candidateRows };
      }
      if (text.includes('SELECT id\n    FROM fatedrop_card_printings')) {
        return { rows: missingIds.map((id) => ({ id })) };
      }
      throw new Error('Unexpected query: ' + text);
    },
  };
}

test('artwork backfill dry-run requires complete rehearsal coverage and plans only missing production rows', async () => {
  const candidateRows = Array.from({ length: 20023 }, (_, i) => ({
    id: 'p' + (i + 1),
    attributes: { artwork: { thumbnailUrl: 'https://example.com/' + (i + 1) + '.webp' } },
  }));
  const production = mockDb({
    total: 20023,
    withThumbnail: 20021,
    missingIds: ['p20022', 'p20023'],
  });
  const rehearsal = mockDb({
    total: 20023,
    withThumbnail: 20023,
    missingIds: [],
    candidateRows,
  });
  const report = await executeArtworkBackfill({ production, rehearsal, write: false });
  assert.equal(report.status, 'dry_run_passed');
  assert.equal(report.productionWrites, false);
  assert.equal(report.planned, 2);
  assert.equal(report.before.withThumbnail, 20021);
  assert.equal(report.rehearsal.withThumbnail, 20023);
});

test('artwork backfill refuses incomplete rehearsal artwork', async () => {
  const production = mockDb({ total: 20023, withThumbnail: 936, missingIds: ['p1'] });
  const rehearsal = mockDb({ total: 20023, withThumbnail: 20022, missingIds: ['p1'], candidateRows: [] });
  await assert.rejects(
    executeArtworkBackfill({ production, rehearsal, write: false }),
    /complete artwork coverage/,
  );
});
