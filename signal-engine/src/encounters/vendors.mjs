import crypto from "node:crypto";

const SOURCE_TYPES=new Set(['organiser_submission','retailer_submission','manual_research','authorised_feed','official_tcg']);
const VERIFICATION_STATES=new Set(['submitted','source_verified','fatedrop_verified']);
const INVENTORY_SCOPES=new Set(['event_vendor_submission','fatedrop_event_inventory']);
const AVAILABILITY=new Set(['available','low_stock','sold_out','unknown']);
const text=(value)=>String(value??'').trim()||null;
const list=(value)=>Array.isArray(value)?[...new Set(value.map((item)=>String(item||'').trim().toLowerCase()).filter(Boolean))]:[];
function url(value){const raw=text(value);if(!raw)return null;try{const parsed=new URL(raw);return ['http:','https:'].includes(parsed.protocol)?parsed.toString():null}catch{return null}}
function iso(value,{required=false}={}){if(value==null||value===''){if(required)throw new Error('Timestamp required');return null}const date=new Date(value);if(Number.isNaN(date.getTime()))throw new Error('Invalid timestamp');return date.toISOString()}
function id(prefix,key){return `${prefix}_${crypto.createHash('sha256').update(key).digest('hex').slice(0,20)}`}

export function normalizeEncounterVendor(record={}){
  const eventId=text(record.eventId);const name=text(record.name);
  if(!eventId||!name)throw new Error('Event vendor requires eventId and name');
  const key=`${eventId}|${name.toLowerCase()}`;
  return{
    id:text(record.id)||id('vendor',key),eventId,retailerId:text(record.retailerId),name,websiteUrl:url(record.websiteUrl),
    stallLabel:text(record.stallLabel),zoneLabel:text(record.zoneLabel),supportedTcgs:list(record.supportedTcgs),
    verificationStatus:VERIFICATION_STATES.has(record.verificationStatus)?record.verificationStatus:'submitted',
    sourceType:SOURCE_TYPES.has(record.sourceType)?record.sourceType:'organiser_submission',sourceUrl:url(record.sourceUrl),
    lastVerifiedAt:iso(record.lastVerifiedAt),
  };
}

export function normalizeEncounterInventory(record={}){
  const eventId=text(record.eventId),vendorId=text(record.vendorId),title=text(record.title);
  if(!eventId||!vendorId||!title)throw new Error('Event inventory requires eventId, vendorId and title');
  const observedAt=iso(record.observedAt||new Date().toISOString(),{required:true});
  const rawPrice=record.pricePence==null?null:Number(record.pricePence),rawQuantity=record.quantity==null?null:Number(record.quantity);
  if(rawPrice!=null&&(!Number.isInteger(rawPrice)||rawPrice<0))throw new Error('Event inventory pricePence must be a non-negative integer');
  if(rawQuantity!=null&&(!Number.isInteger(rawQuantity)||rawQuantity<0))throw new Error('Event inventory quantity must be a non-negative integer');
  const key=`${eventId}|${vendorId}|${text(record.productId)||title.toLowerCase()}|${observedAt}`;
  return{
    id:text(record.id)||id('eventstock',key),eventId,vendorId,productId:text(record.productId),title,pricePence:rawPrice,quantity:rawQuantity,
    availability:AVAILABILITY.has(record.availability)?record.availability:'unknown',
    evidenceScope:INVENTORY_SCOPES.has(record.evidenceScope)?record.evidenceScope:'event_vendor_submission',
    observedAt,expiresAt:iso(record.expiresAt),
  };
}

export function normalizeVendorBatch(records=[]){const accepted=[],rejected=[];for(const[index,record]of records.entries()){try{accepted.push(normalizeEncounterVendor(record))}catch(error){rejected.push({index,name:text(record?.name),reason:String(error?.message||error)})}}return{vendors:accepted,rejected,received:records.length,accepted:accepted.length};}
export function normalizeInventoryBatch(records=[]){const accepted=[],rejected=[];for(const[index,record]of records.entries()){try{accepted.push(normalizeEncounterInventory(record))}catch(error){rejected.push({index,title:text(record?.title),reason:String(error?.message||error)})}}return{inventory:accepted,rejected,received:records.length,accepted:accepted.length};}
