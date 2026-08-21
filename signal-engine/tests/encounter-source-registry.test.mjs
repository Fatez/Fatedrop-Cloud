import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encounterSourceById,
  encounterSourcePolicy,
  encounterSourceRegistry,
  sourcesDueForReview,
  validateEncounterSource,
} from '../src/encounters/source-registry.mjs';

test('encounter source registry contains only approved source-of-truth categories and unique ids', () => {
  const sources = encounterSourceRegistry();
  assert.ok(sources.length >= 10);
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  for (const source of sources) {
    assert.equal(source.stockEvidenceAllowed, false);
    assert.equal(source.ingestionPolicy, 'manual_or_authorised_feed');
    assert.match(source.url, /^https:\/\//);
  }
});

test('third-party discovery directories cannot be promoted to source of truth', () => {
  for (const hostname of encounterSourcePolicy.directoryHostsNotSourceOfTruth) {
    const result = validateEncounterSource({
      id: 'bad-source',
      name: 'Directory',
      url: `https://${hostname}/events`,
      category: 'official_organiser',
      reviewEveryDays: 2,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('directory_not_source_of_truth'));
  }
  assert.equal(encounterSourcePolicy.discoveryDirectoriesAreLeadsOnly, true);
  assert.equal(encounterSourcePolicy.automaticPageScrapingAllowed, false);
});

test('source lookup and review cadence make stale organiser coverage explicit', () => {
  assert.equal(encounterSourceById('northern-card-shows')?.name, 'Northern Card Shows');
  const now = new Date('2026-08-21T12:00:00Z');
  const due = sourcesDueForReview({
    now,
    lastReviewedById: {
      'northern-card-shows': '2026-08-20T12:00:00Z',
      'card-con': '2026-08-10T12:00:00Z',
    },
  });
  assert.equal(due.some((source) => source.id === 'northern-card-shows'), false);
  assert.equal(due.some((source) => source.id === 'card-con'), true);
});
