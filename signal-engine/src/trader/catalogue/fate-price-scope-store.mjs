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

export async function listScopedVerifiedCardsFromStore(store, {
  tcgCode = null,
  seriesId = null,
  setId = null,
  query = null,
  languageCode = null,
  variantCode = null,
  limit = 200,
} = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const search = String(query || '').trim().toLowerCase();

  if (typeof store?.read === 'function') {
    const state = await store.read();
    const catalogue = state?.traderCatalogue ?? {};
    const tcgs = catalogue.tcgs ?? {};
    const series = catalogue.series ?? {};
    const sets = catalogue.sets ?? {};
    const printings = catalogue.printings ?? {};
    const cards = catalogue.cards ?? {};

    return Object.values(cards)
      .filter((card) => card?.verificationStatus === 'verified')
      .filter((card) => printings[card.printingId]?.verificationStatus === 'verified')
      .filter((card) => sets[card.setId]?.verificationStatus === 'verified')
      .filter((card) => series[card.seriesId]?.verificationStatus === 'verified')
      .filter((card) => !tcgCode || tcgs[card.tcgId]?.code === tcgCode)
      .filter((card) => !seriesId || card.seriesId === seriesId)
      .filter((card) => !setId || card.setId === setId)
      .filter((card) => !languageCode || card.languageCode === languageCode)
      .filter((card) => !variantCode || card.variantCode === variantCode)
      .filter((card) => {
        if (!search) return true;
        const printing = printings[card.printingId];
        return String(printing?.name || '').toLowerCase().includes(search)
          || String(card.collectorNumber || '').toLowerCase().includes(search);
      })
      .sort((a, b) => String(a.collectorNumber).localeCompare(String(b.collectorNumber), undefined, { numeric: true }) || a.variantCode.localeCompare(b.variantCode))
      .slice(0, safeLimit)
      .map((card) => publicCard(card, printings[card.printingId], sets[card.setId], series[card.seriesId], tcgs[card.tcgId]));
  }

  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const values = [];
  const conditions = [
    "c.verification_status='verified'",
    "p.verification_status='verified'",
    "s.verification_status='verified'",
    "ser.verification_status='verified'",
  ];
  if (tcgCode) { values.push(tcgCode); conditions.push(`t.code=$${values.length}`); }
  if (seriesId) { values.push(seriesId); conditions.push(`c.series_id=$${values.length}`); }
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
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE WHEN c.collector_number ~ '^[0-9]+$' THEN 0 ELSE 1 END,
      CASE WHEN c.collector_number ~ '^[0-9]+$' THEN c.collector_number::numeric END NULLS LAST,
      LOWER(c.collector_number),
      c.variant_code
    LIMIT $${values.length}`, values);
  return rows.map(dbCard);
}
