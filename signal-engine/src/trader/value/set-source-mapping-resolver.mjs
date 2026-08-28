function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function publicMapping(mapping) {
  if (!mapping) return null;
  return Object.freeze({
    id: mapping.id,
    setId: mapping.setId,
    sourceName: mapping.sourceName,
    sourceRecordId: mapping.sourceRecordId,
  });
}

export async function resolveVerifiedExactSetSourceMapping(store, {
  sourceName,
  sourceRecordId,
  tcgCode = 'pokemon',
} = {}) {
  const safeSourceName = requireText(sourceName, 'sourceName');
  const safeSourceRecordId = requireText(sourceRecordId, 'sourceRecordId');
  const safeTcgCode = requireText(tcgCode, 'tcgCode').toLowerCase();

  if (typeof store?.read === 'function') {
    const state = await store.read();
    const catalogue = state?.traderCatalogue;
    if (!catalogue) return null;

    const mapping = Object.values(catalogue.setSourceMappings || {}).find((candidate) => (
      candidate.sourceName === safeSourceName
      && candidate.sourceRecordId === safeSourceRecordId
    ));
    if (!mapping) return null;

    const set = catalogue.sets?.[mapping.setId];
    const tcg = set ? catalogue.tcgs?.[set.tcgId] : null;
    if (!set || set.verificationStatus !== 'verified' || tcg?.code !== safeTcgCode) return null;
    return publicMapping(mapping);
  }

  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT
      m.id,
      m.set_id,
      m.source_name,
      m.source_record_id
    FROM fatedrop_card_set_source_mappings m
    JOIN fatedrop_card_sets s ON s.id=m.set_id
    JOIN fatedrop_tcgs t ON t.id=s.tcg_id
    WHERE m.source_name=$1
      AND m.source_record_id=$2
      AND s.verification_status='verified'
      AND t.code=$3
    LIMIT 1`, [safeSourceName, safeSourceRecordId, safeTcgCode]);

  if (!rows[0]) return null;
  return publicMapping({
    id: rows[0].id,
    setId: rows[0].set_id,
    sourceName: rows[0].source_name,
    sourceRecordId: rows[0].source_record_id,
  });
}
