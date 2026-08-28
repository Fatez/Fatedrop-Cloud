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
    cardIdentityId: mapping.cardIdentityId,
    sourceName: mapping.sourceName,
    sourceRecordId: mapping.sourceRecordId,
    sourceVariantKey: mapping.sourceVariantKey,
  });
}

export async function resolveVerifiedExactCardSourceMapping(store, {
  sourceName,
  sourceRecordId,
  sourceVariantKey,
} = {}) {
  const safeSourceName = requireText(sourceName, 'sourceName');
  const safeSourceRecordId = requireText(sourceRecordId, 'sourceRecordId');
  const safeSourceVariantKey = requireText(sourceVariantKey, 'sourceVariantKey');

  if (typeof store?.read === 'function') {
    const state = await store.read();
    const catalogue = state?.traderCatalogue;
    if (!catalogue) return null;

    const mapping = Object.values(catalogue.cardSourceMappings || {}).find((candidate) => (
      candidate.sourceName === safeSourceName
      && candidate.sourceRecordId === safeSourceRecordId
      && candidate.sourceVariantKey === safeSourceVariantKey
    ));
    if (!mapping) return null;

    const card = catalogue.cards?.[mapping.cardIdentityId];
    if (!card || card.verificationStatus !== 'verified') return null;
    return publicMapping(mapping);
  }

  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT
      m.id,
      m.card_identity_id,
      m.source_name,
      m.source_record_id,
      m.source_variant_key
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
    WHERE m.source_name=$1
      AND m.source_record_id=$2
      AND m.source_variant_key=$3
      AND c.verification_status='verified'
    LIMIT 1`, [safeSourceName, safeSourceRecordId, safeSourceVariantKey]);

  if (!rows[0]) return null;
  return publicMapping({
    id: rows[0].id,
    cardIdentityId: rows[0].card_identity_id,
    sourceName: rows[0].source_name,
    sourceRecordId: rows[0].source_record_id,
    sourceVariantKey: rows[0].source_variant_key,
  });
}
