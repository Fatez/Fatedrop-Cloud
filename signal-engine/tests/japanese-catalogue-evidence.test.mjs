import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileJapaneseCatalogueAcquisition } from '../src/trader/catalogue/japanese-catalogue-evidence.mjs';

const raw = (value) => JSON.stringify(value);
function snapshot(provider, scopeType, sourceRecordId, setCode, locator, payload) {
  const body = raw(payload);
  return { provider, scopeType, sourceRecordId, setCode, sourceLocator: locator, observedAt: 1_789_200_000_000, payloadSha256: createHash('sha256').update(body).digest('hex'), canonicalSha256: createHash('sha256').update(body).digest('hex'), rawPayloadText: body };
}

function acquisition({ variants = [{ name: 'normal' }], tcgdexVariants = { normal: true }, rarityCode = 'C' } = {}) {
  const setCode = 'SV2a';
  const tcgdexCard = { id: 'sv2a-001', localId: '001', name: 'フシギダネ', variants: tcgdexVariants };
  const scrydexCard = { id: 'sv2a_ja-001', name: 'フシギダネ', number: '1', printed_number: '001/165', rarity: 'コモン', rarity_code: rarityCode, language_code: 'JA', images: [{ type: 'front', small: 'https://images.example/sv2a-001.jpg' }], variants };
  const scrydexPage = { status: 'success', data: [scrydexCard], page: 1, pageSize: 100, totalCount: 1 };
  const cardPageSnapshot = snapshot('scrydex', 'set', 'sv2a_ja:cards:1', setCode, 'https://api.scrydex.com/pokemon/v1/ja/expansions/sv2a_ja/cards?page=1&page_size=100', scrydexPage);
  return {
    format: 'fatedrop-japanese-catalogue-acquisition-v1', runId: 'jp-test-run', generatedAt: '2026-09-13T00:00:00.000Z', productionWrites: false,
    quarantinedSetIds: [], errors: [],
    imageProbes: { 'https://images.example/sv2a-001.jpg': { url: 'https://images.example/sv2a-001.jpg', status: 200, contentType: 'image/jpeg', observedAt: 1_789_200_000_000, ok: true } },
    sets: [{
      nativeSetCode: setCode, tcgdexSetId: 'sv2a', scrydexExpansionId: 'sv2a_ja',
      tcgdexSet: { id: 'sv2a', name: 'ポケモンカード151', cards: [{ id: tcgdexCard.id }] },
      scrydexExpansion: { id: 'sv2a_ja', name: 'ポケモンカード151', series: 'Scarlet & Violet', code: setCode, language_code: 'JA', is_online_only: false, release_date: '2023/06/16', printed_total: 165, total: 210 },
      tcgdexCards: [tcgdexCard], scrydexCards: [scrydexCard],
      scrydexCardEvidence: { [scrydexCard.id]: { payloadSha256: cardPageSnapshot.payloadSha256, sourceLocator: cardPageSnapshot.sourceLocator, observedAt: cardPageSnapshot.observedAt } },
    }],
    snapshots: [
      snapshot('tcgdex', 'set', 'sv2a', setCode, 'https://api.tcgdex.net/v2/ja/sets/sv2a', { id: 'sv2a', cards: [{ id: tcgdexCard.id }] }),
      snapshot('tcgdex', 'card', tcgdexCard.id, setCode, `https://api.tcgdex.net/v2/ja/cards/${tcgdexCard.id}`, tcgdexCard),
      cardPageSnapshot,
    ],
  };
}

test('Poké Ball and Master Ball are separate physical Japanese identities sharing base artwork', () => {
  const input = acquisition({ variants: [{ name: 'normal' }, { name: 'pokeBallReverseHolofoil' }, { name: 'masterBallReverseHolofoil' }] });
  const artifact = compileJapaneseCatalogueAcquisition(input, { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' });
  assert.equal(artifact.counts.printings, 1);
  assert.equal(artifact.counts.cardIdentities, 3);
  assert.equal(artifact.audit.variantsByState.ACTIVE_UNPRICED, 3);
  assert.equal(artifact.audit.variantsByState.ACTIVE_PRICED, 0);
  assert.deepEqual(artifact.rows.cardIdentities.map((row) => row.variantCode).sort(), ['reverse-holo+masterball', 'reverse-holo+pokeball', 'standard']);
  assert.equal(artifact.rows.printings[0].attributes.artwork.thumbnailUrl, 'https://images.example/sv2a-001.jpg');
  assert.deepEqual(new Set(artifact.rows.variantStates.map((row) => row.markerType)), new Set(['none', 'pokeball_reverse', 'masterball_reverse']));
});

test('rarity can create a candidate but cannot prove existence', () => {
  const artifact = compileJapaneseCatalogueAcquisition(acquisition({ variants: [], tcgdexVariants: {}, rarityCode: 'SAR' }), { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' });
  assert.equal(artifact.counts.cardIdentities, 1);
  assert.equal(artifact.rows.cardIdentities[0].variantCode, 'holo');
  assert.equal(artifact.audit.variantsByState.UNRESOLVED_EVIDENCE, 1);
  assert.equal(artifact.rows.cardIdentities[0].verificationStatus, 'quarantined');
  assert.equal(artifact.counts.auditHolds, 1);
});

test('1st Edition requires explicit metadata and is part of canonical identity', () => {
  const artifact = compileJapaneseCatalogueAcquisition(acquisition({ variants: [{ name: 'firstEditionHolofoil' }], tcgdexVariants: {} }), { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' });
  assert.equal(artifact.rows.cardIdentities[0].variantCode, 'holo+1st-edition');
  assert.equal(artifact.rows.variantStates[0].edition, 'first_edition');
  assert.equal(artifact.rows.variantStates[0].state, 'ACTIVE_UNPRICED');
});

test('unknown labels never become existence evidence', () => {
  const artifact = compileJapaneseCatalogueAcquisition(acquisition({ variants: [{ name: 'mysterySparkle' }], tcgdexVariants: {} }), { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' });
  assert.equal(artifact.audit.unrecognisedVariantLabels, 1);
  assert.equal(artifact.audit.variantsByState.UNRESOLVED_EVIDENCE, 1);
});

test('provider or exact-card crosswalk failures block compilation', () => {
  const blocked = acquisition(); blocked.errors.push({ stage: 'set_crosswalk', setId: 'SV2a' });
  assert.throws(() => compileJapaneseCatalogueAcquisition(blocked, { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' }), /acquisition errors present/);
  const mismatch = acquisition(); mismatch.sets[0].scrydexCards[0].number = '2';
  assert.throws(() => compileJapaneseCatalogueAcquisition(mismatch, { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' }), /exact Japanese card crosswalk failed/);
});

test('Japanese compiler never emits a market price write', () => {
  const artifact = compileJapaneseCatalogueAcquisition(acquisition(), { verifiedAt: 1_789_200_000_000, reviewReference: 'pr-test' });
  assert.equal(artifact.productionWrites, false);
  assert.equal(artifact.rows.variantStates[0].currentPriceAmount, null);
  assert.equal(artifact.rows.variantStates[0].exactMappingVerified, false);
});
