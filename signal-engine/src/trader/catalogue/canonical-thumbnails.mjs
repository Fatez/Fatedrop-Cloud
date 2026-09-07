export const CANONICAL_THUMBNAIL_POLICY_VERSION = 'canonical-thumbnails:pilot-1';

const PILOT_SETS = Object.freeze({
  fdset_20b6a6dcfa52bbe0cc54b919: Object.freeze({ name:'Prismatic Evolutions', tcgdexSeriesCode:'sv', tcgdexSetId:'sv08.5', languageCode:'en' }),
  fdset_15b58d7fe24f94690c51184b: Object.freeze({ name:'Temporal Forces', tcgdexSeriesCode:'sv', tcgdexSetId:'sv05', languageCode:'en' }),
  fdset_067d68020460e775d43ff0cb: Object.freeze({ name:'151', tcgdexSeriesCode:'sv', tcgdexSetId:'sv03.5', languageCode:'en' }),
  fdset_373e293fbb2882e43122afde: Object.freeze({ name:'Darkness Ablaze', tcgdexSeriesCode:'swsh', tcgdexSetId:'swsh3', languageCode:'en' }),
});

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function pilotSet(canonicalSetId) { return PILOT_SETS[text(canonicalSetId)] ?? null; }
function root(set) { return `https://assets.tcgdex.net/${set.languageCode}/${encodeURIComponent(set.tcgdexSeriesCode)}/${encodeURIComponent(set.tcgdexSetId)}`; }

export function resolveCanonicalSetThumbnail({ canonicalSetId } = {}) {
  const set = pilotSet(canonicalSetId);
  if (!set) return Object.freeze({ status:'quarantined', reason:'canonical_set_not_in_bounded_pilot', imageUrl:null, thumbnailUrl:null });
  const imageUrl = `${root(set)}/logo.webp`;
  return Object.freeze({
    status:'verified', reason:null, kind:'set', provider:'tcgdex', canonicalSetId:text(canonicalSetId),
    sourceRecordId:set.tcgdexSetId, languageCode:set.languageCode, imageUrl, thumbnailUrl:imageUrl,
    usageBasis:'provider_documented_remote_asset_display_no_local_redistribution', attributionRequired:false,
    policyVersion:CANONICAL_THUMBNAIL_POLICY_VERSION,
  });
}

/**
 * Resolve a card thumbnail only from an exact persisted TCGdex card-source record.
 * `sourceRecordId` must be the exact upstream key (for example sv03.5-001).
 * No card name, fuzzy collector-number lookup or artwork similarity is accepted.
 */
export function resolveCanonicalCardThumbnail({ canonicalSetId, sourceName, sourceRecordId } = {}) {
  const set = pilotSet(canonicalSetId);
  if (!set) return Object.freeze({ status:'quarantined', reason:'canonical_set_not_in_bounded_pilot', imageUrl:null, thumbnailUrl:null });
  if (text(sourceName) !== 'tcgdex') return Object.freeze({ status:'quarantined', reason:'exact_tcgdex_source_mapping_required', imageUrl:null, thumbnailUrl:null });
  const exactSourceRecordId = text(sourceRecordId);
  const prefix = `${set.tcgdexSetId}-`;
  if (!exactSourceRecordId.startsWith(prefix) || exactSourceRecordId.length <= prefix.length) {
    return Object.freeze({ status:'quarantined', reason:'source_record_id_conflicts_with_verified_set_mapping', imageUrl:null, thumbnailUrl:null });
  }
  const localId = exactSourceRecordId.slice(prefix.length);
  if (!/^[A-Za-z0-9._-]+$/.test(localId)) return Object.freeze({ status:'rejected', reason:'malformed_source_local_id', imageUrl:null, thumbnailUrl:null });
  const base = `${root(set)}/${encodeURIComponent(localId)}`;
  return Object.freeze({
    status:'verified', reason:null, kind:'card', provider:'tcgdex', canonicalSetId:text(canonicalSetId),
    sourceRecordId:exactSourceRecordId, languageCode:set.languageCode,
    thumbnailUrl:`${base}/low.webp`, imageUrl:`${base}/high.webp`,
    usageBasis:'provider_documented_remote_asset_display_no_local_redistribution', attributionRequired:false,
    policyVersion:CANONICAL_THUMBNAIL_POLICY_VERSION,
  });
}

export function listCanonicalThumbnailPilotSets() {
  return Object.entries(PILOT_SETS).map(([canonicalSetId, set]) => Object.freeze({ canonicalSetId, ...set }));
}
