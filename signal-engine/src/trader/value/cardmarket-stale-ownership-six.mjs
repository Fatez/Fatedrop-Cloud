import { createHash } from 'node:crypto';

export const stableCardmarketMappingId = (cardIdentityId, sourceRecordId, sourceVariantKey) =>
  `fdcardmap_${createHash('sha256')
    .update([cardIdentityId, 'cardmarket', String(sourceRecordId), sourceVariantKey].join('|'))
    .digest('hex')
    .slice(0, 24)}`;

export const CARDMARKET_STALE_OWNERSHIP_SIX = Object.freeze([
  Object.freeze({
    key: 'deoxys-rayquaza', staleMappingId: 'fdcardmap_08a55b896314c61c0d313e3d', sourceVariantKey: 'holo',
    target: Object.freeze({ cardIdentityId: 'fdcard_62b14039f556176d932ef9bf', tcgdexId: 'ex8-22', setName: 'Deoxys', name: 'Rayquaza', collectorNumber: '22', variantCode: 'holo', sourceRecordId: '276425', expansionId: '1546', productName: 'Rayquaza [Dragon Aura | Tumbling Attack]' }),
    displaced: Object.freeze({ cardIdentityId: 'fdcard_1d878487043141c6ae59b1ac', tcgdexId: 'ex8-107', setName: 'Deoxys', name: 'Rayquaza ☆', collectorNumber: '107', variantCode: 'holo', sourceRecordId: '276510', expansionId: '1546', productName: 'Rayquaza Gold Star [Spiral Rush | Holy Star]' }),
  }),
  Object.freeze({
    key: 'hgss-meganium', staleMappingId: 'fdcardmap_d6ec0806de1e1b1dab69422a', sourceVariantKey: 'holo',
    target: Object.freeze({ cardIdentityId: 'fdcard_b1273b872c4a31e07a910f80', tcgdexId: 'hgss1-26', setName: 'HeartGold SoulSilver', name: 'Meganium', collectorNumber: '26', variantCode: 'holo', sourceRecordId: '278998', expansionId: '1566', productName: 'Meganium [Sleep Powder | Giant Bloom]' }),
    displaced: Object.freeze({ cardIdentityId: 'fdcard_5900039b4393a2bb2d0a46fb', tcgdexId: 'hgss1-109', setName: 'HeartGold SoulSilver', name: 'Meganium', collectorNumber: '109', variantCode: 'holo', sourceRecordId: '279081', expansionId: '1566', productName: 'Meganium [Leaf Trans | Solarbeam | Prime]' }),
  }),
  Object.freeze({
    key: 'legends-awakened-lanturn', staleMappingId: 'fdcardmap_a423740d9466066919766529', sourceVariantKey: 'normal',
    target: Object.freeze({ cardIdentityId: 'fdcard_a3316a52df349f51146513de', tcgdexId: 'dp6-58', setName: 'Legends Awakened', name: 'Lanturn', collectorNumber: '58', variantCode: 'standard', sourceRecordId: '278207', expansionId: '1560', productName: 'Lanturn Lv.39 [Rushing Water | Confuse Ray]' }),
    displaced: Object.freeze({ cardIdentityId: 'fdcard_c6d67fdc6dbee079aa7c0dd5', tcgdexId: 'dp6-59', setName: 'Legends Awakened', name: 'Lanturn', collectorNumber: '59', variantCode: 'standard', sourceRecordId: '278208', expansionId: '1560', productName: 'Lanturn Lv.43 [Energy Split | Aqua Bolt]' }),
  }),
  Object.freeze({
    key: 'stormfront-magnemite', staleMappingId: 'fdcardmap_e82286957c7696ff7cf54a7b', sourceVariantKey: 'normal',
    target: Object.freeze({ cardIdentityId: 'fdcard_add8d56c588dbccc11089adb', tcgdexId: 'dp7-66', setName: 'Stormfront', name: 'Magnemite', collectorNumber: '66', variantCode: 'standard', sourceRecordId: '278364', expansionId: '1561', productName: 'Magnemite Lv.15 [Magnet | Magnetic Bomb]' }),
    displaced: Object.freeze({ cardIdentityId: 'fdcard_1df06193cec66e1b1df0bd03', tcgdexId: 'dp7-67', setName: 'Stormfront', name: 'Magnemite', collectorNumber: '67', variantCode: 'standard', sourceRecordId: '278365', expansionId: '1561', productName: 'Magnemite Lv.13 [Ram | Random Spark]' }),
  }),
  Object.freeze({
    key: 'unleashed-steelix', staleMappingId: 'fdcardmap_f90b7c0819a801b85784042f', sourceVariantKey: 'holo',
    target: Object.freeze({ cardIdentityId: 'fdcard_a29e556b7224cbe7db83a5b9', tcgdexId: 'hgss2-24', setName: 'Unleashed', name: 'Steelix', collectorNumber: '24', variantCode: 'holo', sourceRecordId: '279180', expansionId: '1567', productName: 'Steelix [Guard Press | Steel Swing]' }),
    displaced: Object.freeze({ cardIdentityId: 'fdcard_6b39502725f515453943db61', tcgdexId: 'hgss2-87', setName: 'Unleashed', name: 'Steelix', collectorNumber: '87', variantCode: 'holo', sourceRecordId: '279243', expansionId: '1567', productName: 'Steelix [Perfect Metal | Energy Stream | Gaia Crush | Prime]' }),
  }),
  Object.freeze({
    key: 'xy-champions-festival', staleMappingId: 'fdcardmap_0edc6cdd003f69ac5747741d', sourceVariantKey: 'normal',
    target: Object.freeze({ cardIdentityId: 'fdcard_e682b4505d21bde83111edbf', tcgdexId: 'xyp-XY27', setName: 'XY Black Star Promos', name: 'Champions Festival', collectorNumber: 'xy27', variantCode: 'standard', sourceRecordId: '281314', expansionId: '1612', productName: 'Champions Festival [Duckboat]' }),
    displaced: Object.freeze({ cardIdentityId: 'fdcard_40acf892996e149896269ef1', tcgdexId: 'xyp-XY176', setName: 'XY Black Star Promos', name: 'Champions Festival', collectorNumber: 'xy176', variantCode: 'standard', sourceRecordId: '291974', expansionId: '1612', productName: 'Champions Festival [Duckboat]' }),
  }),
]);

export function staleOwnershipSixDigest(rows = CARDMARKET_STALE_OWNERSHIP_SIX) {
  return createHash('sha256')
    .update(rows.map((row) => [
      row.key, row.staleMappingId, row.sourceVariantKey,
      row.target.cardIdentityId, row.target.tcgdexId, row.target.sourceRecordId,
      row.displaced.cardIdentityId, row.displaced.tcgdexId, row.displaced.sourceRecordId,
      stableCardmarketMappingId(row.displaced.cardIdentityId, row.displaced.sourceRecordId, row.sourceVariantKey),
    ].join('|')).sort().join('\n'))
    .digest('hex');
}

export const CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST = 'cb4a930339ada07b18136fc637f02188c0297c2980c4c15a969099a8103b425e';

if (staleOwnershipSixDigest() !== CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST) {
  throw new Error('Cardmarket stale-ownership-six manifest digest drift');
}
