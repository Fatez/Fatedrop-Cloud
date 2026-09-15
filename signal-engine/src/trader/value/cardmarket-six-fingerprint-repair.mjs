import { createHash } from 'node:crypto';
import { CARDMARKET_STALE_OWNERSHIP_SIX } from './cardmarket-stale-ownership-six.mjs';
import { marketObservationFromPostgres, normaliseMarketObservationCandidate } from './market-observation.mjs';

export function buildSixFingerprintRepair(manifest) {
  if (manifest.expectedCount !== 27 || manifest.rows?.length !== 27) throw new Error('Frozen 27-row manifest required');
  const seen = new Set();
  const pairs = new Set();
  const repairs = manifest.rows.map(row => {
    if (seen.has(row.id)) throw new Error('Duplicate observation in manifest');
    seen.add(row.id);
    const pair = CARDMARKET_STALE_OWNERSHIP_SIX.find(p => p.target.sourceRecordId === row.source_record_id
      && p.sourceVariantKey === row.source_variant_key);
    if (!pair || row.source_name !== 'cardmarket' || row.card_identity_id !== pair.target.cardIdentityId) throw new Error('Unexpected observation ownership');
    pairs.add(pair.key);
    const corrected = marketObservationFromPostgres(row);
    const historical = normaliseMarketObservationCandidate({ ...corrected,
      cardIdentityId: pair.displaced.cardIdentityId, cardSourceMappingId: pair.staleMappingId });
    if (corrected.id !== row.id || historical.contentFingerprint !== row.content_fingerprint) {
      throw new Error('Fingerprint is not proven to originate from frozen stale owner');
    }
    return { row, expectedFingerprint: corrected.contentFingerprint };
  });
  if (pairs.size !== 6) throw new Error('All six frozen source keys required');
  const encoded = JSON.stringify(repairs);
  const manifestSha256 = createHash('sha256').update(encoded).digest('hex');
  // Full typed row equality catches price, evidence, timestamp, owner, or lane drift.
  // The update touches only the checksum; original evidence remains in this manifest.
  const sql = `DO $repair$
DECLARE item jsonb; expected fatedrop_market_observations; actual fatedrop_market_observations; n integer;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements('${encoded.replaceAll("'", "''")}'::jsonb) LOOP
    SELECT * INTO expected FROM jsonb_populate_record(NULL::fatedrop_market_observations, item->'row');
    SELECT * INTO actual FROM fatedrop_market_observations WHERE id=expected.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing frozen observation %', expected.id; END IF;
    PERFORM 1 FROM fatedrop_card_source_mappings m JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
      WHERE m.id=expected.card_source_mapping_id AND m.card_identity_id=expected.card_identity_id
      AND m.source_name=expected.source_name AND m.source_record_id=expected.source_record_id
      AND m.source_variant_key=expected.source_variant_key AND c.verification_status='verified' FOR SHARE OF m,c;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mapping ownership drift %', expected.id; END IF;
    IF actual.content_fingerprint=item->>'expectedFingerprint' THEN
      expected.content_fingerprint := item->>'expectedFingerprint';
      IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Corrected observation drift %', expected.id; END IF;
      CONTINUE;
    END IF;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Frozen observation drift %', expected.id; END IF;
    UPDATE fatedrop_market_observations SET content_fingerprint=item->>'expectedFingerprint'
      WHERE id=expected.id AND content_fingerprint=expected.content_fingerprint;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'Repair count drift %', expected.id; END IF;
  END LOOP;
END $repair$`;
  return { manifestSha256, count: repairs.length, repairs, sql };
}
