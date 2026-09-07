import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_THUMBNAIL_POLICY_VERSION,
  listCanonicalThumbnailPilotSets,
  resolveCanonicalCardThumbnail,
  resolveCanonicalSetThumbnail,
} from '../src/trader/catalogue/canonical-thumbnails.mjs';

test('canonical thumbnail pilot is bounded to the four live exact-mapped sets', () => {
  assert.equal(CANONICAL_THUMBNAIL_POLICY_VERSION, 'canonical-thumbnails:pilot-1');
  assert.deepEqual(listCanonicalThumbnailPilotSets().map((row) => row.canonicalSetId).sort(), [
    'fdset_067d68020460e775d43ff0cb',
    'fdset_15b58d7fe24f94690c51184b',
    'fdset_20b6a6dcfa52bbe0cc54b919',
    'fdset_373e293fbb2882e43122afde',
  ]);
});

test('set thumbnail resolves only from an allowlisted canonical set identity', () => {
  const resolved = resolveCanonicalSetThumbnail({ canonicalSetId:'fdset_067d68020460e775d43ff0cb' });
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.thumbnailUrl, 'https://assets.tcgdex.net/en/sv/sv03.5/logo.webp');
  assert.equal(resolveCanonicalSetThumbnail({ canonicalSetId:'fdset_unknown' }).status, 'quarantined');
});

test('card thumbnail preserves exact TCGdex source local id including leading zeroes', () => {
  const resolved = resolveCanonicalCardThumbnail({
    canonicalSetId:'fdset_067d68020460e775d43ff0cb',
    sourceName:'tcgdex',
    sourceRecordId:'sv03.5-001',
  });
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.thumbnailUrl, 'https://assets.tcgdex.net/en/sv/sv03.5/001/low.webp');
  assert.equal(resolved.imageUrl, 'https://assets.tcgdex.net/en/sv/sv03.5/001/high.webp');
});

test('card thumbnails fail closed on provider, set and source-record conflicts', () => {
  assert.equal(resolveCanonicalCardThumbnail({ canonicalSetId:'fdset_067d68020460e775d43ff0cb', sourceName:'other', sourceRecordId:'sv03.5-001' }).status, 'quarantined');
  assert.equal(resolveCanonicalCardThumbnail({ canonicalSetId:'fdset_067d68020460e775d43ff0cb', sourceName:'tcgdex', sourceRecordId:'sv05-001' }).status, 'quarantined');
  assert.equal(resolveCanonicalCardThumbnail({ canonicalSetId:'fdset_unknown', sourceName:'tcgdex', sourceRecordId:'sv03.5-001' }).status, 'quarantined');
  assert.equal(resolveCanonicalCardThumbnail({ canonicalSetId:'fdset_067d68020460e775d43ff0cb', sourceName:'tcgdex', sourceRecordId:'sv03.5-../bad' }).status, 'rejected');
});
