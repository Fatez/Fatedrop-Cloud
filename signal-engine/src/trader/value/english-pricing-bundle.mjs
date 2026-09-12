import { createHash } from 'node:crypto';
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function checkpointValid(checkpoint, context) {
  return checkpoint?.context === context && checkpoint.output?.productionWrites === false
    && checkpoint.outputDigest === digest(checkpoint.output);
}
const key = (...parts) => JSON.stringify(parts.map(String));
export function combineRecoveryProposals({ identities, mappings, reports, validate = () => null }) {
  const identitiesById = new Map(identities.map(r => [r.id,r]));
  const raw = reports.flatMap(({stage,report}) => (report.candidates || []).map(row => ({...row, stage})));
  const sourceOwners = new Map(), identityProducts = new Map();
  const add = (map,k,v) => { const s=map.get(k)||new Set();s.add(String(v));map.set(k,s); };
  for(const r of mappings) {
    add(sourceOwners,key(r.source_record_id,r.source_variant_key),r.card_identity_id);
    add(identityProducts,key(r.card_identity_id,r.source_variant_key),r.source_record_id);
  }
  // Include ALL proposals before rejecting conflicts. Never keep the first winner.
  for(const r of raw) {
    add(sourceOwners,key(r.sourceRecordId,r.sourceVariantKey),r.cardIdentityId);
    add(identityProducts,key(r.cardIdentityId,r.sourceVariantKey),r.sourceRecordId);
  }
  const accepted = new Map(), held=[];
  for(const row of raw) {
    const identity=identitiesById.get(row.cardIdentityId);
    let reason;
    if(!identity || identity.language_code!=='en' || identity.verification_status!=='verified') reason='identity_outside_verified_english_scope';
    else if(!['standard','holo'].includes(identity.variant_code) || row.sourceVariantKey !== (identity.variant_code==='standard'?'normal':'holo')) reason='finish_mismatch';
    else if(mappings.some(m=>m.card_identity_id===identity.id)) reason='identity_already_mapped_requires_separate_review';
    else if(sourceOwners.get(key(row.sourceRecordId,row.sourceVariantKey))?.size!==1) reason='cross_stage_source_ownership_conflict';
    else if(identityProducts.get(key(row.cardIdentityId,row.sourceVariantKey))?.size!==1) reason='cross_stage_identity_product_conflict';
    else reason=validate(row,identity);
    if(reason) { held.push({...row,reason});continue; }
    const k=key(row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey);
    const prior=accepted.get(k);
    if(prior) prior.methods.push(row.stage);
    else accepted.set(k,{...row,methods:[row.stage]});
  }
  return { candidates:[...accepted.values()].sort((a,b)=>a.cardIdentityId.localeCompare(b.cardIdentityId)), held };
}
