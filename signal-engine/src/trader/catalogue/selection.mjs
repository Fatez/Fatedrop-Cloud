function normaliseRequestedSetIds(requestedSetIds) {
  if (requestedSetIds == null) return Object.freeze([]);
  if (!Array.isArray(requestedSetIds)) throw new TypeError('requestedSetIds must be an array');
  const ids = requestedSetIds.map((value) => String(value ?? '').trim()).filter(Boolean);
  if (ids.length > 100) throw new TypeError('At most 100 catalogue set IDs may be selected at once');
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new TypeError('Requested catalogue set IDs must be unique');
  return Object.freeze(ids);
}

export function selectVerifiedSetCrosswalk(plan, requestedSetIds = null) {
  if (!plan || !Array.isArray(plan.matched)) throw new TypeError('crosswalk.matched is required');
  const requested = normaliseRequestedSetIds(requestedSetIds);
  if (requested.length === 0) {
    return Object.freeze({
      mode: 'all',
      requestedSetIds: requested,
      selected: plan.matched,
      crosswalk: plan,
    });
  }

  const byTcgdexSetId = new Map(plan.matched.map((entry) => [String(entry?.tcgdexSetId ?? '').trim(), entry]));
  const missing = requested.filter((id) => !byTcgdexSetId.has(id));
  if (missing.length > 0) {
    throw new Error(`Requested catalogue set is not in the verified crosswalk: ${missing.join(', ')}`);
  }

  const selected = Object.freeze(requested.map((id) => byTcgdexSetId.get(id)));
  const crosswalk = Object.freeze({ ...plan, matched: selected });
  return Object.freeze({
    mode: 'targeted',
    requestedSetIds: requested,
    selected,
    crosswalk,
  });
}
