const EXCLUDED_RESOLUTION_STATES = Object.freeze([
  'INVALID_CATALOGUE_ENTRY',
  'UNRESOLVED_EVIDENCE',
]);

function cardIdentityId(card) {
  const value = card?.fateCardId ?? card?.id;
  return typeof value === 'string' ? value.trim() : '';
}

export async function filterCollectionEligibleCardsFromStore(store, cards) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  if (cards.length === 0 || typeof store?.pool !== 'function') return cards;

  const ids = [...new Set(cards.map(cardIdentityId).filter(Boolean))];
  if (ids.length === 0) return cards;

  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT card_identity_id,classifier_state
    FROM fatedrop_variant_resolution_state
    WHERE card_identity_id=ANY($1::text[])
      AND classifier_state=ANY($2::text[])`, [ids, EXCLUDED_RESOLUTION_STATES]);
  const excluded = new Set(rows.map((row) => String(row.card_identity_id || '').trim()).filter(Boolean));
  if (excluded.size === 0) return cards;
  return cards.filter((card) => !excluded.has(cardIdentityId(card)));
}
