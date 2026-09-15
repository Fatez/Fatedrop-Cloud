// Explicit, rollback-only operator rehearsal. No production activation entrypoint.
export const priorDigest = 'cb4a930339ada07b18136fc637f02188c0297c2980c4c15a969099a8103b425e';
export const cases = [
 ['276425','holo','276510','fdcard_62b14039f556176d932ef9bf','fdcard_1d878487043141c6ae59b1ac','fdcardmap_08a55b896314c61c0d313e3d','ex8-22','ex8-107','Rayquaza','Rayquaza ☆',6],
 ['278998','holo','279081','fdcard_b1273b872c4a31e07a910f80','fdcard_5900039b4393a2bb2d0a46fb','fdcardmap_d6ec0806de1e1b1dab69422a','hgss1-26','hgss1-109','Meganium','Meganium',5],
 ['278207','normal','278208','fdcard_a3316a52df349f51146513de','fdcard_c6d67fdc6dbee079aa7c0dd5','fdcardmap_a423740d9466066919766529','dp6-58','dp6-59','Lanturn','Lanturn',4],
 ['278364','normal','278365','fdcard_add8d56c588dbccc11089adb','fdcard_1df06193cec66e1b1df0bd03','fdcardmap_e82286957c7696ff7cf54a7b','dp7-66','dp7-67','Magnemite','Magnemite',4],
 ['279180','holo','279243','fdcard_a29e556b7224cbe7db83a5b9','fdcard_6b39502725f515453943db61','fdcardmap_f90b7c0819a801b85784042f','hgss2-24','hgss2-87','Steelix','Steelix',5],
 ['281314','normal','291974','fdcard_e682b4505d21bde83111edbf','fdcard_40acf892996e149896269ef1','fdcardmap_0edc6cdd003f69ac5747741d','xyp-XY27','xyp-XY176','Champions Festival','Champions Festival',3],
];
const literal = v => typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;
export function rehearsalSql() {
 return `BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE fatedrop_card_source_mappings, fatedrop_market_observations IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE repair_cases ON COMMIT DROP AS SELECT * FROM (VALUES
${cases.map(row=>'('+row.map(literal).join(',')+')').join(',\n')}
) AS v(product,lane,replacement,target,displaced,stale,tcg_target,tcg_displaced,target_name,displaced_name,observation_count);
CREATE TEMP TABLE before_mappings ON COMMIT DROP AS SELECT * FROM fatedrop_card_source_mappings;
CREATE TEMP TABLE before_observations ON COMMIT DROP AS SELECT * FROM fatedrop_market_observations;
CREATE TEMP TABLE before_identities ON COMMIT DROP AS SELECT * FROM fatedrop_card_identities;
DO $repair$
#variable_conflict use_column
DECLARE r record; n integer;
BEGIN
 PERFORM 1 FROM fatedrop_card_identities WHERE id IN (SELECT target FROM repair_cases UNION SELECT displaced FROM repair_cases) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM fatedrop_card_printings WHERE id IN (SELECT printing_id FROM fatedrop_card_identities WHERE id IN (SELECT target FROM repair_cases UNION SELECT displaced FROM repair_cases)) ORDER BY id FOR SHARE;
 FOR r IN SELECT * FROM repair_cases ORDER BY product LOOP
  SELECT count(*) INTO n FROM fatedrop_card_identities c JOIN fatedrop_card_printings p ON p.id=c.printing_id JOIN fatedrop_card_source_mappings m ON m.card_identity_id=c.id
  WHERE c.id IN (r.target,r.displaced) AND c.verification_status='verified' AND c.language_code='en' AND c.tcg_id='fdtcg_pokemon'
  AND c.variant_code=CASE WHEN r.lane='normal' THEN 'standard' ELSE 'holo' END
  AND m.source_name='tcgdex' AND m.source_variant_key=r.lane
  AND m.source_record_id=CASE WHEN c.id=r.target THEN r.tcg_target ELSE r.tcg_displaced END
  AND lower(c.collector_number)=lower(split_part(m.source_record_id,'-',2))
  AND p.name=CASE WHEN c.id=r.target THEN r.target_name ELSE r.displaced_name END
  AND c.set_id=(SELECT set_id FROM fatedrop_card_identities WHERE id=r.target);
  IF n<>2 THEN RAISE EXCEPTION 'Identity evidence drift: %',r.product; END IF;
  IF NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings WHERE id=r.stale AND source_name='cardmarket' AND source_record_id=r.product AND source_variant_key=r.lane AND card_identity_id=r.displaced) THEN RAISE EXCEPTION 'Stale owner drift: %',r.product; END IF;
  IF EXISTS(SELECT 1 FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=r.replacement AND source_variant_key=r.lane AND card_identity_id<>r.displaced) THEN RAISE EXCEPTION 'Replacement occupied: %',r.replacement; END IF;
  SELECT count(*) INTO n FROM fatedrop_market_observations WHERE card_source_mapping_id=r.stale;
  IF n<>r.observation_count THEN RAISE EXCEPTION 'Observation count drift: %',r.product; END IF;
  IF EXISTS(SELECT 1 FROM fatedrop_market_observations WHERE card_source_mapping_id=r.stale AND (card_identity_id<>r.displaced OR source_name<>'cardmarket' OR source_record_id<>r.product OR source_variant_key<>r.lane)) THEN RAISE EXCEPTION 'Observation key drift: %',r.product; END IF;
 END LOOP;
 FOR r IN SELECT * FROM repair_cases ORDER BY product LOOP
  UPDATE fatedrop_card_source_mappings SET source_record_id='retired-stale:'||r.stale WHERE id=r.stale;
  INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,first_observed_at,last_observed_at)
  SELECT 'sixrepair:'||r.product||':'||r.lane,r.target,'cardmarket',r.product,r.lane,source_url,'six-owner-repair-v1',first_observed_at,last_observed_at FROM before_mappings WHERE id=r.stale;
  UPDATE fatedrop_market_observations SET card_identity_id=r.target,card_source_mapping_id='sixrepair:'||r.product||':'||r.lane WHERE card_source_mapping_id=r.stale;
  DELETE FROM fatedrop_card_source_mappings WHERE id=r.stale;
  INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,first_observed_at,last_observed_at)
  SELECT 'sixrepair:'||r.replacement||':'||r.lane,r.displaced,'cardmarket',r.replacement,r.lane,NULL,'six-owner-repair-v1:user-reviewed',first_observed_at,last_observed_at FROM before_mappings WHERE id=r.stale
  ON CONFLICT(source_name,source_record_id,source_variant_key) DO NOTHING;
 END LOOP;
 IF EXISTS(SELECT 1 FROM repair_cases r WHERE NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.source_record_id=r.product AND m.source_variant_key=r.lane AND m.card_identity_id=r.target) OR NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.source_record_id=r.replacement AND m.source_variant_key=r.lane AND m.card_identity_id=r.displaced)) THEN RAISE EXCEPTION 'Post ownership failed'; END IF;
 IF EXISTS((SELECT * FROM before_identities EXCEPT SELECT * FROM fatedrop_card_identities) UNION ALL (SELECT * FROM fatedrop_card_identities EXCEPT SELECT * FROM before_identities)) THEN RAISE EXCEPTION 'Canonical identities changed'; END IF;
 IF EXISTS(SELECT 1 FROM before_observations b FULL JOIN fatedrop_market_observations o USING(id) LEFT JOIN repair_cases r ON r.stale=b.card_source_mapping_id WHERE b.id IS NULL OR o.id IS NULL OR (to_jsonb(b)-'card_identity_id'-'card_source_mapping_id') IS DISTINCT FROM (to_jsonb(o)-'card_identity_id'-'card_source_mapping_id') OR o.card_identity_id IS DISTINCT FROM COALESCE(r.target,b.card_identity_id) OR o.card_source_mapping_id IS DISTINCT FROM CASE WHEN r.product IS NULL THEN b.card_source_mapping_id ELSE 'sixrepair:'||r.product||':'||r.lane END) THEN RAISE EXCEPTION 'Observation preservation failed'; END IF;
 IF EXISTS(SELECT 1 FROM before_mappings b LEFT JOIN fatedrop_card_source_mappings m USING(id) WHERE b.id NOT IN(SELECT stale FROM repair_cases) AND to_jsonb(b) IS DISTINCT FROM to_jsonb(m)) THEN RAISE EXCEPTION 'Unrelated lane changed'; END IF;
 IF EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m LEFT JOIN fatedrop_card_identities c ON c.id=m.card_identity_id WHERE c.id IS NULL) OR EXISTS(SELECT 1 FROM fatedrop_market_observations o LEFT JOIN fatedrop_card_source_mappings m ON m.id=o.card_source_mapping_id WHERE m.id IS NULL OR m.source_record_id LIKE 'retired-stale:%') THEN RAISE EXCEPTION 'Orphan or retired attachment'; END IF;
 IF EXISTS(SELECT 1 FROM fatedrop_card_source_mappings GROUP BY source_name,source_record_id,source_variant_key HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate source key'; END IF;
END $repair$;
SELECT r.*,m.id after_mapping,m.card_identity_id after_owner,(SELECT count(*) FROM fatedrop_market_observations o WHERE o.card_source_mapping_id=m.id) after_observations FROM repair_cases r JOIN fatedrop_card_source_mappings m ON m.source_name='cardmarket' AND m.source_record_id IN(r.product,r.replacement) AND m.source_variant_key=r.lane ORDER BY r.product,m.source_record_id;
ROLLBACK;`;
}
