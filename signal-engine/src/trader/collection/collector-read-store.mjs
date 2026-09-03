const DEFAULT_COLLECTION_ITEM_CAP = 10_000;
const DEFAULT_SET_CARD_CAP = 5_000;
const DEFAULT_OWNED_CARD_CAP = 10_000;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function positiveCap(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 50_000) throw new TypeError('collector read cap is invalid');
  return number;
}

function fileCatalogue(state) {
  return state?.traderCatalogue ?? {tcgs:{},series:{},sets:{},printings:{},cards:{}};
}

function publicFileCard(catalogue, card) {
  const printing=catalogue.printings?.[card.printingId];
  const set=catalogue.sets?.[card.setId];
  const series=catalogue.series?.[card.seriesId];
  const tcg=catalogue.tcgs?.[card.tcgId];
  return Object.freeze({
    id:card.id,
    fateCardId:card.id,
    tcgCode:tcg?.code ?? null,
    seriesId:card.seriesId,
    seriesName:series?.name ?? null,
    setId:card.setId,
    setName:set?.name ?? null,
    printingId:card.printingId,
    name:printing?.name ?? null,
    collectorNumber:card.collectorNumber,
    rarity:printing?.rarity ?? null,
    supertype:printing?.supertype ?? null,
    variantCode:card.variantCode,
    languageCode:card.languageCode,
    verificationStatus:card.verificationStatus,
    verifiedAt:card.verifiedAt ?? null,
  });
}

function publicDbCard(row) {
  return Object.freeze({
    id:row.id,
    fateCardId:row.id,
    tcgCode:row.tcg_code,
    seriesId:row.series_id,
    seriesName:row.series_name,
    setId:row.set_id,
    setName:row.set_name,
    printingId:row.printing_id,
    name:row.name,
    collectorNumber:row.collector_number,
    rarity:row.rarity,
    supertype:row.supertype,
    variantCode:row.variant_code,
    languageCode:row.language_code,
    verificationStatus:row.verification_status,
    verifiedAt:row.verified_at == null ? null : Number(row.verified_at),
  });
}

function publicFileItem(data,item) {
  return Object.freeze({
    id:item.id,
    fateCardId:item.fateCardId,
    quantity:Number(item.quantity),
    tradeQuantity:Number(item.tradeQuantity ?? 0),
    availableToTrade:Number(item.tradeQuantity ?? 0)>0,
    copyState:item.copyState,
    conditionCode:item.conditionCode ?? null,
    grading:data.grading?.[item.id] ?? item.grading ?? null,
    notes:item.notes ?? null,
    status:item.status,
    revision:Number(item.revision),
    createdAt:Number(item.createdAt),
    updatedAt:Number(item.updatedAt),
  });
}

function publicDbItem(row) {
  const grading=row.grading_company ? Object.freeze({
    gradingCompany:row.grading_company,
    gradeLabel:row.grade_label,
    gradeValue:row.grade_value == null ? null : Number(row.grade_value),
    certificationNumber:row.certification_number,
    certificationStatus:row.certification_status,
    verificationSource:row.verification_source,
    verifiedAt:row.verified_at == null ? null : Number(row.verified_at),
  }) : null;
  return Object.freeze({
    id:row.id,
    fateCardId:row.card_identity_id,
    quantity:Number(row.quantity),
    tradeQuantity:Number(row.trade_quantity),
    availableToTrade:Number(row.trade_quantity)>0,
    copyState:row.copy_state,
    conditionCode:row.condition_code,
    grading,
    notes:row.notes,
    status:row.status,
    revision:Number(row.revision),
    createdAt:Number(row.created_at),
    updatedAt:Number(row.updated_at),
  });
}

function cardSort(a,b){
  return String(a.collectorNumber).localeCompare(String(b.collectorNumber),undefined,{numeric:true})
    || String(a.variantCode).localeCompare(String(b.variantCode))
    || String(a.languageCode).localeCompare(String(b.languageCode));
}

export async function readCollectorCollectionItemsFromStore(store, {
  userId,
  maxItems=DEFAULT_COLLECTION_ITEM_CAP,
}={}) {
  const ownerId=text(userId);
  if(!ownerId)throw new TypeError('userId is required');
  const cap=positiveCap(maxItems,DEFAULT_COLLECTION_ITEM_CAP);

  if(typeof store?.read==='function'){
    const state=await store.read();
    const data=state?.traderCollection ?? {collections:{},items:{},grading:{}};
    const collectionIds=new Set(Object.values(data.collections||{}).filter((row)=>row.userId===ownerId).map((row)=>row.id));
    const all=Object.values(data.items||{})
      .filter((item)=>collectionIds.has(item.collectionId)&&item.status!=='removed')
      .sort((a,b)=>Number(b.updatedAt)-Number(a.updatedAt)||String(a.id).localeCompare(String(b.id)));
    const totalUnits=all.reduce((sum,item)=>sum+Number(item.quantity||0),0);
    return Object.freeze({
      sourceType:'file',
      totalItems:all.length,
      totalUnits,
      truncated:all.length>cap,
      maxItems:cap,
      items:Object.freeze(all.slice(0,cap).map((item)=>publicFileItem(data,item))),
    });
  }

  if(typeof store?.pool!=='function')throw new Error('Collection persistence is unavailable');
  const pool=await store.pool();
  const {rows}=await pool.query(`SELECT i.*,g.grading_company,g.grade_label,g.grade_value,g.certification_number,
      g.certification_status,g.verification_source,g.verified_at,
      COUNT(*) OVER() AS total_item_count,
      SUM(i.quantity) OVER() AS total_units
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id=i.id
    WHERE c.user_id=$1 AND i.status='active'
    ORDER BY i.updated_at DESC,i.id
    LIMIT $2`,[ownerId,cap+1]);
  const totalItems=rows[0]?Number(rows[0].total_item_count):0;
  const totalUnits=rows[0]?Number(rows[0].total_units):0;
  return Object.freeze({
    sourceType:'postgres',
    totalItems,
    totalUnits,
    truncated:totalItems>cap,
    maxItems:cap,
    items:Object.freeze(rows.slice(0,cap).map(publicDbItem)),
  });
}

export async function readCollectorVerifiedCardsByIdsFromStore(store, fateCardIds, {
  maxCards=DEFAULT_OWNED_CARD_CAP,
}={}) {
  if(!Array.isArray(fateCardIds))throw new TypeError('fateCardIds must be an array');
  const cap=positiveCap(maxCards,DEFAULT_OWNED_CARD_CAP);
  const allIds=[...new Set(fateCardIds.map(text).filter(Boolean))];
  const truncated=allIds.length>cap;
  const ids=allIds.slice(0,cap);
  if(!ids.length)return Object.freeze({sourceType:null,requestedCount:0,truncated:false,maxCards:cap,cards:Object.freeze([])});

  if(typeof store?.read==='function'){
    const catalogue=fileCatalogue(await store.read());
    const cards=ids.map((id)=>catalogue.cards?.[id])
      .filter((card)=>card?.verificationStatus==='verified')
      .filter((card)=>catalogue.printings?.[card.printingId]?.verificationStatus==='verified')
      .filter((card)=>catalogue.sets?.[card.setId]?.verificationStatus==='verified')
      .map((card)=>publicFileCard(catalogue,card));
    return Object.freeze({sourceType:'file',requestedCount:allIds.length,truncated,maxCards:cap,cards:Object.freeze(cards)});
  }

  if(typeof store?.pool!=='function')throw new Error('Catalogue persistence is unavailable');
  const pool=await store.pool();
  const {rows}=await pool.query(`SELECT c.*,p.name,p.rarity,p.supertype,s.name AS set_name,ser.name AS series_name,t.code AS tcg_code
    FROM fatedrop_card_identities c
    JOIN fatedrop_card_printings p ON p.id=c.printing_id
    JOIN fatedrop_card_sets s ON s.id=c.set_id
    JOIN fatedrop_card_series ser ON ser.id=c.series_id
    JOIN fatedrop_tcgs t ON t.id=c.tcg_id
    WHERE c.id=ANY($1::text[])
      AND c.verification_status='verified'
      AND p.verification_status='verified'
      AND s.verification_status='verified'`,[ids]);
  const byId=new Map(rows.map((row)=>[row.id,publicDbCard(row)]));
  return Object.freeze({
    sourceType:'postgres',requestedCount:allIds.length,truncated,maxCards:cap,
    cards:Object.freeze(ids.map((id)=>byId.get(id)).filter(Boolean)),
  });
}

export async function readCollectorVerifiedSetCardsFromStore(store, {
  setId,
  maxCards=DEFAULT_SET_CARD_CAP,
}={}) {
  const canonicalSetId=text(setId);
  if(!canonicalSetId)throw new TypeError('setId is required');
  const cap=positiveCap(maxCards,DEFAULT_SET_CARD_CAP);

  if(typeof store?.read==='function'){
    const catalogue=fileCatalogue(await store.read());
    const all=Object.values(catalogue.cards||{})
      .filter((card)=>card.verificationStatus==='verified'&&card.setId===canonicalSetId)
      .filter((card)=>catalogue.printings?.[card.printingId]?.verificationStatus==='verified')
      .filter((card)=>catalogue.sets?.[card.setId]?.verificationStatus==='verified')
      .map((card)=>publicFileCard(catalogue,card))
      .sort(cardSort);
    return Object.freeze({
      sourceType:'file',setId:canonicalSetId,totalCards:all.length,truncated:all.length>cap,maxCards:cap,
      cards:Object.freeze(all.slice(0,cap)),
    });
  }

  if(typeof store?.pool!=='function')throw new Error('Catalogue persistence is unavailable');
  const pool=await store.pool();
  const {rows}=await pool.query(`SELECT c.*,p.name,p.rarity,p.supertype,s.name AS set_name,ser.name AS series_name,t.code AS tcg_code,
      COUNT(*) OVER() AS total_card_count
    FROM fatedrop_card_identities c
    JOIN fatedrop_card_printings p ON p.id=c.printing_id
    JOIN fatedrop_card_sets s ON s.id=c.set_id
    JOIN fatedrop_card_series ser ON ser.id=c.series_id
    JOIN fatedrop_tcgs t ON t.id=c.tcg_id
    WHERE c.set_id=$1
      AND c.verification_status='verified'
      AND p.verification_status='verified'
      AND s.verification_status='verified'
    ORDER BY
      CASE WHEN c.collector_number ~ '^[0-9]+$' THEN 0 ELSE 1 END,
      CASE WHEN c.collector_number ~ '^[0-9]+$' THEN c.collector_number::numeric END NULLS LAST,
      LOWER(c.collector_number),c.variant_code,c.language_code
    LIMIT $2`,[canonicalSetId,cap+1]);
  const totalCards=rows[0]?Number(rows[0].total_card_count):0;
  return Object.freeze({
    sourceType:'postgres',setId:canonicalSetId,totalCards,truncated:totalCards>cap,maxCards:cap,
    cards:Object.freeze(rows.slice(0,cap).map(publicDbCard)),
  });
}
