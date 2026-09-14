import { normaliseArtworkUrl } from './artwork.mjs';

function thumbnailFromAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  return normaliseArtworkUrl(attributes.artwork?.thumbnailUrl);
}

function cardList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

async function thumbnailMapFromFileStore(store, printingIds) {
  const state = await store.read();
  const printings = state?.traderCatalogue?.printings || {};
  const map = new Map();
  for (const printingId of printingIds) {
    map.set(printingId, thumbnailFromAttributes(printings[printingId]?.attributes));
  }
  return map;
}

async function thumbnailMapFromPostgres(store, printingIds) {
  const pool = await store.pool();
  const { rows } = await pool.query(
    `SELECT id, attributes->'artwork'->>'thumbnailUrl' AS thumbnail_url
       FROM fatedrop_card_printings
      WHERE verification_status='verified'
        AND id = ANY($1::text[])`,
    [printingIds],
  );
  return new Map(rows.map((row) => [row.id, normaliseArtworkUrl(row.thumbnail_url)]));
}

async function thumbnailMap(store, printingIds) {
  if (!printingIds.length) return new Map();
  if (typeof store?.read === 'function') return thumbnailMapFromFileStore(store, printingIds);
  if (typeof store?.pool === 'function') return thumbnailMapFromPostgres(store, printingIds);
  return new Map();
}

export async function enrichCardsWithArtworkFromStore(store, cards) {
  const list = cardList(cards);
  if (!list.length) return Array.isArray(cards) ? [] : null;

  const printingIds = [...new Set(list.map((card) => card?.printingId).filter(Boolean))];
  const thumbnails = await thumbnailMap(store, printingIds);
  const enriched = list.map((card) => ({
    ...card,
    thumbnailUrl: thumbnails.get(card.printingId) ?? null,
  }));

  return Array.isArray(cards) ? enriched : enriched[0];
}
