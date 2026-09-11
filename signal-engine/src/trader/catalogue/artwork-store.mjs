import { normaliseArtworkUrl } from './artwork.mjs';

function uniqueIds(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function artworkFromAttributes(attributes) {
  const artwork = attributes && typeof attributes === 'object' ? attributes.artwork : null;
  const thumbnailUrl = normaliseArtworkUrl(artwork?.thumbnailUrl);
  if (!thumbnailUrl) return null;
  return Object.freeze({
    thumbnailUrl,
    sourceName: artwork?.sourceName ?? null,
    sourceRecordId: artwork?.sourceRecordId ?? null,
    sourceUrl: normaliseArtworkUrl(artwork?.sourceUrl),
  });
}

export async function persistVerifiedPrintingArtwork(store, printings, { observedAt = Date.now() } = {}) {
  if (!Array.isArray(printings)) throw new TypeError('printings must be an array');
  const rows = printings
    .map((printing) => ({ id: printing?.id, artwork: artworkFromAttributes(printing?.attributes) }))
    .filter((row) => row.id && row.artwork);
  if (!rows.length) return Object.freeze({ saved: 0 });

  if (typeof store?.mutate === 'function') {
    return store.mutate((state) => {
      const catalogue = state.traderCatalogue;
      if (!catalogue?.printings) return { saved: 0 };
      let saved = 0;
      for (const row of rows) {
        const printing = catalogue.printings[row.id];
        if (!printing) continue;
        catalogue.printings[row.id] = {
          ...printing,
          attributes: { ...(printing.attributes || {}), artwork: row.artwork },
          updatedAt: Math.max(Number(printing.updatedAt || 0), Number(observedAt || 0)),
        };
        saved += 1;
      }
      return { saved };
    });
  }

  if (typeof store?.pool !== 'function') return Object.freeze({ saved: 0 });
  const pool = await store.pool();
  const payload = rows.map((row) => ({ id: row.id, artwork: row.artwork }));
  const { rowCount = 0 } = await pool.query(`
    UPDATE fatedrop_card_printings AS p
    SET attributes = COALESCE(p.attributes, '{}'::jsonb) || jsonb_build_object('artwork', incoming.artwork),
        updated_at = GREATEST(p.updated_at, $2::bigint)
    FROM jsonb_to_recordset($1::jsonb) AS incoming(id text, artwork jsonb)
    WHERE p.id = incoming.id
      AND p.verification_status = 'verified'`, [JSON.stringify(payload), observedAt]);
  return Object.freeze({ saved: rowCount });
}

export async function listPrintingArtworkFromStore(store, printingIds) {
  const ids = uniqueIds(printingIds);
  if (!ids.length) return new Map();

  if (typeof store?.read === 'function') {
    const state = await store.read();
    const printings = state?.traderCatalogue?.printings || {};
    return new Map(ids.map((id) => [id, artworkFromAttributes(printings[id]?.attributes)]).filter(([, artwork]) => artwork));
  }

  if (typeof store?.pool !== 'function') return new Map();
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT id, attributes
    FROM fatedrop_card_printings
    WHERE id = ANY($1::text[])
      AND verification_status = 'verified'`, [ids]);
  return new Map(rows.map((row) => [row.id, artworkFromAttributes(row.attributes)]).filter(([, artwork]) => artwork));
}

export async function enrichCardsWithPrintingArtwork(store, cards) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  const artwork = await listPrintingArtworkFromStore(store, cards.map((card) => card?.printingId));
  return Object.freeze(cards.map((card) => Object.freeze({
    ...card,
    thumbnailUrl: artwork.get(card?.printingId)?.thumbnailUrl ?? card?.thumbnailUrl ?? null,
  })));
}

export async function enrichPrintingsWithArtwork(store, printings) {
  if (!Array.isArray(printings)) throw new TypeError('printings must be an array');
  const artwork = await listPrintingArtworkFromStore(store, printings.map((printing) => printing?.printingId ?? printing?.id));
  return Object.freeze(printings.map((printing) => {
    const id = printing?.printingId ?? printing?.id;
    return Object.freeze({
      ...printing,
      thumbnailUrl: artwork.get(id)?.thumbnailUrl ?? printing?.thumbnailUrl ?? null,
    });
  }));
}

export async function getPrintingArtworkCoverageFromStore(store) {
  if (typeof store?.read === 'function') {
    const state = await store.read();
    const printings = Object.values(state?.traderCatalogue?.printings || {}).filter((printing) => printing?.verificationStatus === 'verified');
    const missing = printings.filter((printing) => !artworkFromAttributes(printing.attributes));
    return Object.freeze({ total: printings.length, withThumbnail: printings.length - missing.length, missing: Object.freeze(missing.map((printing) => printing.id)) });
  }
  if (typeof store?.pool !== 'function') return Object.freeze({ total: 0, withThumbnail: 0, missing: Object.freeze([]) });
  const pool = await store.pool();
  const { rows: [counts] } = await pool.query(`SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE NULLIF(attributes->'artwork'->>'thumbnailUrl','') IS NOT NULL)::int AS with_thumbnail
    FROM fatedrop_card_printings
    WHERE verification_status='verified'`);
  const { rows: missingRows } = await pool.query(`SELECT id,set_id,collector_number,name
    FROM fatedrop_card_printings
    WHERE verification_status='verified'
      AND NULLIF(attributes->'artwork'->>'thumbnailUrl','') IS NULL
    ORDER BY set_id,collector_number`);
  return Object.freeze({
    total: Number(counts?.total || 0),
    withThumbnail: Number(counts?.with_thumbnail || 0),
    missing: Object.freeze(missingRows.map((row) => Object.freeze({
      printingId: row.id,
      setId: row.set_id,
      collectorNumber: row.collector_number,
      name: row.name,
    }))),
  });
}
