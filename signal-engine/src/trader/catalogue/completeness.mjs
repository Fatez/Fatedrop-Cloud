function intOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function verifiedSetCards(canonicalCards,setId) {
  return canonicalCards
    .filter((card)=>card&&card.verificationStatus==='verified')
    .filter((card)=>text(card.setId)===setId);
}

function dimensionGaps(cards) {
  const gaps={printingId:0,collectorNumber:0,languageCode:0,variantCode:0};
  for(const card of cards){
    if(!text(card.printingId))gaps.printingId+=1;
    if(!text(card.collectorNumber))gaps.collectorNumber+=1;
    if(!text(card.languageCode))gaps.languageCode+=1;
    if(!text(card.variantCode))gaps.variantCode+=1;
  }
  return gaps;
}

function hasGaps(gaps){return Object.values(gaps).some((value)=>value>0);}

function duplicateIdentityDimensions(cards) {
  const seen=new Map();
  const duplicates=[];
  for(const card of cards){
    const printingId=text(card.printingId);
    const languageCode=text(card.languageCode).toLowerCase();
    const variantCode=text(card.variantCode).toLowerCase();
    if(!printingId||!languageCode||!variantCode)continue;
    const key=`${printingId}|${languageCode}|${variantCode}`;
    const previous=seen.get(key);
    if(previous&&previous!==text(card.fateCardId??card.id))duplicates.push(key);
    else seen.set(key,text(card.fateCardId??card.id));
  }
  return [...new Set(duplicates)].sort();
}

export function assessCanonicalSetCompleteness({ set, canonicalCards, requiredLanguageCode = null } = {}) {
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');

  const setId = text(set.id);
  if (!setId) throw new TypeError('set.id is required');
  const requiredLanguage=text(requiredLanguageCode).toLowerCase()||null;
  const verifiedCards=verifiedSetCards(canonicalCards,setId);
  const gaps=dimensionGaps(verifiedCards);
  const verifiedPrintingIds = new Set(verifiedCards.map((card)=>text(card.printingId)).filter(Boolean));
  const observedTotal = verifiedPrintingIds.size;
  const expectedTotal = intOrNull(set.total) ?? intOrNull(set.printedTotal);
  const verifiedIdentityCount=verifiedCards.length;

  const base={
    setId,
    expectedTotal:expectedTotal||null,
    observedTotal,
    verifiedIdentityCount,
    requiredLanguageCode:requiredLanguage,
    identityDimensionGaps:Object.freeze(gaps),
  };

  if (hasGaps(gaps)) {
    return Object.freeze({
      status:'incomplete',
      reason:'canonical_identity_dimensions_incomplete',
      ...base,
      missingCanonicalCount:expectedTotal==null?null:Math.max(0,expectedTotal-observedTotal),
    });
  }

  const duplicates=duplicateIdentityDimensions(verifiedCards);
  if(duplicates.length){
    return Object.freeze({
      status:'conflict',
      reason:'canonical_identity_dimension_duplicate',
      ...base,
      missingCanonicalCount:expectedTotal==null?null:Math.max(0,expectedTotal-observedTotal),
      duplicateIdentityDimensions:Object.freeze(duplicates),
    });
  }

  if (expectedTotal == null || expectedTotal === 0) {
    return Object.freeze({
      status: 'unknown',
      reason: 'declared_set_total_unavailable',
      ...base,
      missingCanonicalCount: null,
    });
  }

  if (observedTotal < expectedTotal) {
    return Object.freeze({
      status: 'incomplete',
      reason: 'canonical_checklist_incomplete',
      ...base,
      missingCanonicalCount: expectedTotal - observedTotal,
    });
  }

  if (observedTotal > expectedTotal) {
    return Object.freeze({
      status: 'conflict',
      reason: 'canonical_checklist_exceeds_declared_total',
      ...base,
      missingCanonicalCount: 0,
    });
  }

  if(requiredLanguage){
    const languagePrintingIds=new Set(
      verifiedCards
        .filter((card)=>text(card.languageCode).toLowerCase()===requiredLanguage)
        .map((card)=>text(card.printingId))
        .filter(Boolean),
    );
    if(languagePrintingIds.size<observedTotal){
      return Object.freeze({
        status:'incomplete',
        reason:'required_language_checklist_incomplete',
        ...base,
        requiredLanguageObservedPrintings:languagePrintingIds.size,
        missingRequiredLanguagePrintings:observedTotal-languagePrintingIds.size,
        missingCanonicalCount:0,
      });
    }
  }

  return Object.freeze({
    status: 'complete',
    reason: null,
    ...base,
    missingCanonicalCount: 0,
  });
}
