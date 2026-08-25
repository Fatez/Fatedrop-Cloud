function fileCatalogue(state) {
  state.traderCatalogue ||= {
    tcgs: {},
    series: {},
    sets: {},
    setSourceMappings: {},
    printings: {},
    cards: {},
    cardSourceMappings: {},
    cardProvenance: {},
  };
  return state.traderCatalogue;
}

function sourceKey(sourceName, sourceRecordId, sourceVariantKey = null) {
  return [sourceName, sourceRecordId, sourceVariantKey].filter((part) => part != null).join('|');
}

function publicSet(set, series, tcg) {
  return {
    id: set.id,
    tcgCode: tcg?.code ?? null,
    seriesId: set.seriesId,
    seriesName: series?.name ?? null,
    name: set.name,
    printedTotal: set.printedTotal ?? null,
    total: set.total ?? null,
    releasedAt: set.releasedAt ?? null,
    verificationStatus: set.verificationStatus,
  };
}

function publicCard(card, printing, set, series, tcg) {
  return {
    id: card.id,
    fateCardId: card.id,
    tcgCode: tcg?.code ?? null,
    seriesId: card.seriesId,
    seriesName: series?.name ?? null,
    setId: card.setId,
    setName: set?.name ?? null,
    printingId: card.printingId,
    name: printing?.name ?? null,
    collectorNumber: card.collectorNumber,
    rarity: printing?.rarity ?? null,
    supertype: printing?.supertype ?? null,
    variantCode: card.variantCode,
    languageCode: card.languageCode,
    verificationStatus: card.verificationStatus,
    verifiedAt: card.verifiedAt ?? null,
  };
}

function dbSet(row) {
  return {
    id: row.id,
    tcgCode: row.tcg_code,
    seriesId: row.series_id,
    seriesName: row.series_name,
    name: row.name,
    printedTotal: row.printed_total,
    total: row.total,
    releasedAt: row.released_at == null ? null : Number(row.released_at),
    verificationStatus: row.verification_status,
  };
}

function dbCard(row) {
  return {
    id: row.id,
    fateCardId: row.id,
    tcgCode: row.tcg_code,
    seriesId: row.series_id,
    seriesName: row.series_name,
    setId: row.set_id,
    setName: row.set_name,
    printingId: row.printing_id,
    name: row.name,
    collectorNumber: row.collector_number,
    rarity: row.rarity,
    supertype: row.supertype,
    variantCode: row.variant_code,
    languageCode: row.language_code,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
  };
}

async function persistFile(store, batch) {
  return store.mutate((state) => {
    const catalogue = fileCatalogue(state);
    catalogue.tcgs[batch.tcg.id] = batch.tcg;
    catalogue.series[batch.series.id] = batch.series;
    catalogue.sets[batch.set.id] = batch.set;

    for (const mapping of batch.setSourceMappings) {
      const key = sourceKey(mapping.sourceName, mapping.sourceRecordId);
      const existing = catalogue.setSourceMappings[key];
      if (existing && existing.setId !== mapping.setId) throw new Error('Set source mapping conflict');
      catalogue.setSourceMappings[key] = existing
        ? { ...existing, lastObservedAt: mapping.lastObservedAt, sourceUrl: mapping.sourceUrl ?? existing.sourceUrl }
        : mapping;
    }

    for (const printing of batch.printings) catalogue.printings[printing.id] = printing;
    for (const card of batch.cardIdentities) catalogue.cards[card.id] = card;

    for (const mapping of batch.cardSourceMappings) {
      const key = sourceKey(mapping.sourceName, mapping.sourceRecordId, mapping.sourceVariantKey);
      const existing = catalogue.cardSourceMappings[key];
      if (existing && existing.cardIdentityId !== mapping.cardIdentityId) throw new Error('Card source mapping conflict');
      catalogue.cardSourceMappings[key] = existing
        ? { ...existing, lastObservedAt: mapping.lastObservedAt, sourceUrl: mapping.sourceUrl ?? existing.sourceUrl }
        : mapping;
    }
    for (const evidence of batch.cardProvenance) catalogue.cardProvenance[evidence.id] = evidence;
    return { savedSets: 1, savedPrintings: batch.printings.length, savedCards: batch.cardIdentities.length };
  });
}

async function assertSetMapping(client, mapping) {
  const { rows } = await client.query(
    'SELECT set_id FROM fatedrop_card_set_source_mappings WHERE source_name=$1 AND source_record_id=$2',
    [mapping.sourceName, mapping.sourceRecordId],
  );
  if (rows[0] && rows[0].set_id !== mapping.setId) throw new Error('Set source mapping conflict');
}

async function assertCardMapping(client, mapping) {
  const { rows } = await client.query(
    'SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name=$1 AND source_record_id=$2 AND source_variant_key=$3',
    [mapping.sourceName, mapping.sourceRecordId, mapping.sourceVariantKey],
  );
  if (rows[0] && rows[0].card_identity_id !== mapping.cardIdentityId) throw new Error('Card source mapping conflict');
}

async function persistPostgres(store, batch) {
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`INSERT INTO fatedrop_tcgs (id,code,name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,updated_at=GREATEST(fatedrop_tcgs.updated_at,EXCLUDED.updated_at)`,
    [batch.tcg.id,batch.tcg.code,batch.tcg.name,batch.tcg.status,batch.tcg.createdAt,batch.tcg.updatedAt]);

    await client.query(`INSERT INTO fatedrop_card_series (id,tcg_id,code,name,created_at,updated_at,verification_status,verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,verification_status=EXCLUDED.verification_status,verified_at=EXCLUDED.verified_at,updated_at=GREATEST(fatedrop_card_series.updated_at,EXCLUDED.updated_at)`,
    [batch.series.id,batch.series.tcgId,batch.series.code,batch.series.name,batch.series.createdAt,batch.series.updatedAt,batch.series.verificationStatus,batch.series.verifiedAt]);

    await client.query(`INSERT INTO fatedrop_card_sets (id,tcg_id,series_id,code,name,printed_total,total,released_at,created_at,updated_at,verification_status,verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,printed_total=EXCLUDED.printed_total,total=EXCLUDED.total,released_at=EXCLUDED.released_at,verification_status=EXCLUDED.verification_status,verified_at=EXCLUDED.verified_at,updated_at=GREATEST(fatedrop_card_sets.updated_at,EXCLUDED.updated_at)`,
    [batch.set.id,batch.set.tcgId,batch.set.seriesId,batch.set.code,batch.set.name,batch.set.printedTotal,batch.set.total,batch.set.releasedAt,batch.set.createdAt,batch.set.updatedAt,batch.set.verificationStatus,batch.set.verifiedAt]);

    for (const mapping of batch.setSourceMappings) {
      await assertSetMapping(client, mapping);
      await client.query(`INSERT INTO fatedrop_card_set_source_mappings (id,set_id,source_name,source_record_id,source_series_code,source_url,source_version,first_observed_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (source_name,source_record_id) DO UPDATE SET source_series_code=COALESCE(EXCLUDED.source_series_code,fatedrop_card_set_source_mappings.source_series_code),source_url=COALESCE(EXCLUDED.source_url,fatedrop_card_set_source_mappings.source_url),source_version=COALESCE(EXCLUDED.source_version,fatedrop_card_set_source_mappings.source_version),last_observed_at=GREATEST(fatedrop_card_set_source_mappings.last_observed_at,EXCLUDED.last_observed_at)`,
      [mapping.id,mapping.setId,mapping.sourceName,mapping.sourceRecordId,mapping.sourceSeriesCode,mapping.sourceUrl,mapping.sourceVersion,mapping.firstObservedAt,mapping.lastObservedAt]);
    }

    for (const printing of batch.printings) {
      await client.query(`INSERT INTO fatedrop_card_printings (id,tcg_id,series_id,set_id,printing_code,collector_number,name,rarity,supertype,subtypes,national_dex_numbers,attributes,created_at,updated_at,verification_status,verified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,rarity=COALESCE(EXCLUDED.rarity,fatedrop_card_printings.rarity),supertype=COALESCE(EXCLUDED.supertype,fatedrop_card_printings.supertype),verification_status=EXCLUDED.verification_status,verified_at=EXCLUDED.verified_at,updated_at=GREATEST(fatedrop_card_printings.updated_at,EXCLUDED.updated_at)`,
      [printing.id,printing.tcgId,printing.seriesId,printing.setId,printing.printingCode,printing.collectorNumber,printing.name,printing.rarity,printing.supertype,JSON.stringify(printing.subtypes),JSON.stringify(printing.nationalDexNumbers),JSON.stringify(printing.attributes),printing.createdAt,printing.updatedAt,printing.verificationStatus,printing.verifiedAt]);
    }

    for (const card of batch.cardIdentities) {
      await client.query(`INSERT INTO fatedrop_card_identities (id,canonical_key,tcg_id,series_id,set_id,printing_id,collector_number,variant_code,language_code,verification_status,verified_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET verification_status=EXCLUDED.verification_status,verified_at=EXCLUDED.verified_at,updated_at=GREATEST(fatedrop_card_identities.updated_at,EXCLUDED.updated_at)`,
      [card.id,card.canonicalKey,card.tcgId,card.seriesId,card.setId,card.printingId,card.collectorNumber,card.variantCode,card.languageCode,card.verificationStatus,card.verifiedAt,card.createdAt,card.updatedAt]);
    }

    for (const mapping of batch.cardSourceMappings) {
      await assertCardMapping(client, mapping);
      await client.query(`INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,first_observed_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (source_name,source_record_id,source_variant_key) DO UPDATE SET source_url=COALESCE(EXCLUDED.source_url,fatedrop_card_source_mappings.source_url),source_version=COALESCE(EXCLUDED.source_version,fatedrop_card_source_mappings.source_version),last_observed_at=GREATEST(fatedrop_card_source_mappings.last_observed_at,EXCLUDED.last_observed_at)`,
      [mapping.id,mapping.cardIdentityId,mapping.sourceName,mapping.sourceRecordId,mapping.sourceVariantKey,mapping.sourceUrl,mapping.sourceVersion,mapping.firstObservedAt,mapping.lastObservedAt]);
    }

    for (const evidence of batch.cardProvenance) {
      await client.query(`INSERT INTO fatedrop_card_provenance (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,observed_at,evidence_status,evidence_json,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING`,
      [evidence.id,evidence.cardIdentityId,evidence.sourceName,evidence.sourceRecordId,evidence.sourceVariantKey,evidence.sourceUrl,evidence.observedAt,evidence.evidenceStatus,JSON.stringify(evidence.evidenceJson),evidence.createdAt]);
    }

    await client.query('COMMIT');
    return { savedSets: 1, savedPrintings: batch.printings.length, savedCards: batch.cardIdentities.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function persistVerifiedCatalogueBatch(store, batch) {
  if (!batch?.set || !Array.isArray(batch.cardIdentities)) throw new TypeError('catalogue batch is required');
  if (typeof store?.mutate === 'function') return persistFile(store, batch);
  if (typeof store?.pool === 'function') return persistPostgres(store, batch);
  throw new Error('Fate Trader catalogue persistence is unavailable');
}

export async function listVerifiedCardSeriesFromStore(store, { tcgCode = 'pokemon', limit = 100 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  if (typeof store?.read === 'function') {
    const catalogue = fileCatalogue(await store.read());
    const tcgIds = new Set(Object.values(catalogue.tcgs).filter((tcg) => tcg.code === tcgCode).map((tcg) => tcg.id));
    return Object.values(catalogue.series)
      .filter((series) => tcgIds.has(series.tcgId) && series.verificationStatus === 'verified')
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, safeLimit)
      .map((series) => ({ id: series.id, tcgCode, name: series.name, verificationStatus: series.verificationStatus }));
  }
  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT s.id,t.code AS tcg_code,s.name,s.verification_status
    FROM fatedrop_card_series s JOIN fatedrop_tcgs t ON t.id=s.tcg_id
    WHERE s.verification_status='verified' AND t.code=$1 ORDER BY s.name LIMIT $2`, [tcgCode, safeLimit]);
  return rows.map((row) => ({ id: row.id, tcgCode: row.tcg_code, name: row.name, verificationStatus: row.verification_status }));
}

export async function listVerifiedCardSetsFromStore(store, { tcgCode = 'pokemon', seriesId = null, limit = 500 } = {}) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
  if (typeof store?.read === 'function') {
    const catalogue = fileCatalogue(await store.read());
    const tcgs = catalogue.tcgs;
    return Object.values(catalogue.sets)
      .filter((set) => set.verificationStatus === 'verified')
      .filter((set) => tcgs[set.tcgId]?.code === tcgCode)
      .filter((set) => !seriesId || set.seriesId === seriesId)
      .sort((a, b) => (a.releasedAt ?? 0) - (b.releasedAt ?? 0) || a.name.localeCompare(b.name))
      .slice(0, safeLimit)
      .map((set) => publicSet(set, catalogue.series[set.seriesId], tcgs[set.tcgId]));
  }
  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const values = [tcgCode];
  const conditions = ["s.verification_status='verified'", 't.code=$1'];
  if (seriesId) { values.push(seriesId); conditions.push(`s.series_id=$${values.length}`); }
  values.push(safeLimit);
  const { rows } = await pool.query(`SELECT s.*,t.code AS tcg_code,ser.name AS series_name
    FROM fatedrop_card_sets s JOIN fatedrop_tcgs t ON t.id=s.tcg_id JOIN fatedrop_card_series ser ON ser.id=s.series_id
    WHERE ${conditions.join(' AND ')} ORDER BY s.released_at NULLS LAST,s.name LIMIT $${values.length}`, values);
  return rows.map(dbSet);
}

export async function listVerifiedCardsFromStore(store, {
  setId = null,
  query = null,
  languageCode = null,
  variantCode = null,
  limit = 200,
} = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const search = String(query || '').trim().toLowerCase();
  if (typeof store?.read === 'function') {
    const catalogue = fileCatalogue(await store.read());
    return Object.values(catalogue.cards)
      .filter((card) => card.verificationStatus === 'verified')
      .filter((card) => !setId || card.setId === setId)
      .filter((card) => !languageCode || card.languageCode === languageCode)
      .filter((card) => !variantCode || card.variantCode === variantCode)
      .filter((card) => {
        if (!search) return true;
        const printing = catalogue.printings[card.printingId];
        return String(printing?.name || '').toLowerCase().includes(search)
          || String(card.collectorNumber || '').toLowerCase().includes(search);
      })
      .sort((a, b) => String(a.collectorNumber).localeCompare(String(b.collectorNumber), undefined, { numeric: true }) || a.variantCode.localeCompare(b.variantCode))
      .slice(0, safeLimit)
      .map((card) => publicCard(card,catalogue.printings[card.printingId],catalogue.sets[card.setId],catalogue.series[card.seriesId],catalogue.tcgs[card.tcgId]));
  }
  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const values = [];
  const conditions = ["c.verification_status='verified'", "p.verification_status='verified'", "s.verification_status='verified'"];
  if (setId) { values.push(setId); conditions.push(`c.set_id=$${values.length}`); }
  if (search) { values.push(`%${search}%`); conditions.push(`(LOWER(p.name) LIKE $${values.length} OR LOWER(c.collector_number) LIKE $${values.length})`); }
  if (languageCode) { values.push(languageCode); conditions.push(`c.language_code=$${values.length}`); }
  if (variantCode) { values.push(variantCode); conditions.push(`c.variant_code=$${values.length}`); }
  values.push(safeLimit);
  const { rows } = await pool.query(`SELECT c.*,p.name,p.rarity,p.supertype,s.name AS set_name,ser.name AS series_name,t.code AS tcg_code
    FROM fatedrop_card_identities c
    JOIN fatedrop_card_printings p ON p.id=c.printing_id
    JOIN fatedrop_card_sets s ON s.id=c.set_id
    JOIN fatedrop_card_series ser ON ser.id=c.series_id
    JOIN fatedrop_tcgs t ON t.id=c.tcg_id
    WHERE ${conditions.join(' AND ')} ORDER BY c.collector_number,c.variant_code LIMIT $${values.length}`, values);
  return rows.map(dbCard);
}

export async function getVerifiedCardFromStore(store, fateCardId) {
  const id = String(fateCardId || '').trim();
  if (!id) return null;
  if (typeof store?.read === 'function') {
    const catalogue = fileCatalogue(await store.read());
    const card = catalogue.cards[id];
    if (!card || card.verificationStatus !== 'verified') return null;
    return publicCard(card,catalogue.printings[card.printingId],catalogue.sets[card.setId],catalogue.series[card.seriesId],catalogue.tcgs[card.tcgId]);
  }
  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT c.*,p.name,p.rarity,p.supertype,s.name AS set_name,ser.name AS series_name,t.code AS tcg_code
    FROM fatedrop_card_identities c
    JOIN fatedrop_card_printings p ON p.id=c.printing_id
    JOIN fatedrop_card_sets s ON s.id=c.set_id
    JOIN fatedrop_card_series ser ON ser.id=c.series_id
    JOIN fatedrop_tcgs t ON t.id=c.tcg_id
    WHERE c.id=$1 AND c.verification_status='verified' AND p.verification_status='verified' AND s.verification_status='verified'`, [id]);
  return rows[0] ? dbCard(rows[0]) : null;
}
