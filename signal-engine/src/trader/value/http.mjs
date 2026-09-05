import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import { buildMarketDataReadinessReport } from './market-data-readiness.mjs';
import { FATE_PRICE_MOVEMENT_POLICY } from './fate-price.mjs';
import { buildMarketPulseSnapshotFromStore } from './market-pulse-data.mjs';

const PATH = '/v1/market/pulse';
const SOURCE_NAME = 'cardmarket';
const CURRENCY_CODE = 'EUR';
const PRICE_FIELD = 'fatePrice';
const CONDITION_CODE = 'unspecified';
const MOVEMENT_POLICY = Object.freeze({
  ...FATE_PRICE_MOVEMENT_POLICY,
  baselinePolicy: 'exact_market_day_no_substitution',
});
const ALLOWED_LANES = new Set(['standard', 'holo']);

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function meta() { return { requestId:null, apiVersion:'v1' }; }
function ok(res, data) { json(res,200,{ok:true,data,meta:meta()}); }
function fail(res,status,code,message,details={}) { json(res,status,{ok:false,error:{code,message,retryable:false,details},meta:meta()}); }

function optionalScope(value, { max = 80 } = {}) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text.length > max || !/^[a-z0-9][a-z0-9._-]*$/.test(text)) throw new TypeError('Market scope is invalid');
  return text;
}

function publicReadiness(report) {
  return Object.freeze({
    schemaVersion:report.schemaVersion,
    sourceName:report.sourceName,
    canonicalSchemaAvailable:report.canonicalSchemaAvailable,
    marketHistorySchemaAvailable:report.marketHistorySchemaAvailable,
    canonical:Object.freeze({
      verifiedTcgs:report.canonical.verifiedTcgs,
      verifiedSets:report.canonical.verifiedSets,
      verifiedCards:report.canonical.verifiedCards,
      mappedCards:report.canonical.mappedCards,
      mappingCoveragePct:report.canonical.mappingCoveragePct,
    }),
    history:Object.freeze({
      observations:report.history.observations,
      distinctMarketDays:report.history.distinctMarketDays,
      earliestMarketDay:report.history.earliestMarketDay,
      latestMarketDay:report.history.latestMarketDay,
      currentLaneCount:report.history.currentLaneCount,
      exactBaselineCoverage:report.history.exactBaselineCoverage,
    }),
    issues:report.issues,
  });
}

function unavailablePayload(readiness, reason) {
  return Object.freeze({
    contractVersion:1,
    status:'building',
    reason,
    source:Object.freeze({name:SOURCE_NAME,currencyCode:CURRENCY_CODE,priceField:PRICE_FIELD,movementPolicy:MOVEMENT_POLICY}),
    readiness:publicReadiness(readiness),
    pulse:null,
    intelligence:Object.freeze({
      marketHeat:null,
      volatility:null,
      heatingUp:Object.freeze([]),
      coolingDown:Object.freeze([]),
      movers:Object.freeze([]),
      reason:'phase_1b_not_calibrated',
    }),
  });
}

export function isFatePulsePath(pathname) { return pathname === PATH; }

export async function handleFatePulse(req,res,{store}={}) {
  const url=new URL(req.url||'/',`http://${req.headers?.host||'localhost'}`);
  if(!isFatePulsePath(url.pathname))return false;
  if(req.method!=='GET'){fail(res,405,'METHOD_NOT_ALLOWED','FatePulse is read-only.');return true;}

  try {
    const tcgCode=optionalScope(url.searchParams.get('tcg'));
    if(tcgCode&&!SUPPORTED_TCG_CODES.includes(tcgCode)){
      fail(res,400,'TCG_NOT_SUPPORTED','The requested TCG is not supported.');return true;
    }
    const setCode=optionalScope(url.searchParams.get('set'));
    const lane=optionalScope(url.searchParams.get('lane'))||'standard';
    if(!ALLOWED_LANES.has(lane)){
      fail(res,400,'MARKET_LANE_NOT_SUPPORTED','The requested market lane is not supported.');return true;
    }

    const readiness=await buildMarketDataReadinessReport(store,{sourceName:SOURCE_NAME});
    if(!readiness.canonicalSchemaAvailable){ok(res,unavailablePayload(readiness,'canonical_card_schema_missing'));return true;}
    if(!readiness.marketHistorySchemaAvailable){ok(res,unavailablePayload(readiness,'market_history_schema_missing'));return true;}
    if(!readiness.history.latestMarketDay){ok(res,unavailablePayload(readiness,'no_market_history'));return true;}

    const pulse=await buildMarketPulseSnapshotFromStore(store,{
      sourceName:SOURCE_NAME,
      priceField:PRICE_FIELD,
      currencyCode:CURRENCY_CODE,
      marketSegmentKey:lane,
      conditionCode:CONDITION_CODE,
      tcgCode,
      setCode,
    });
    if(!pulse.anchorMarketDay||pulse.evidence.currentLaneCount===0){
      ok(res,unavailablePayload(readiness,'no_current_evidence_for_scope'));return true;
    }

    ok(res,Object.freeze({
      contractVersion:1,
      status:'available',
      reason:null,
      source:Object.freeze({name:SOURCE_NAME,currencyCode:CURRENCY_CODE,priceField:PRICE_FIELD,lane,movementPolicy:MOVEMENT_POLICY}),
      readiness:publicReadiness(readiness),
      pulse:Object.freeze({
        schemaVersion:pulse.schemaVersion,
        generatedAt:pulse.generatedAt,
        anchorMarketDay:pulse.anchorMarketDay,
        scope:pulse.scope,
        evidence:pulse.evidence,
        movement:pulse.movement,
        games:pulse.games,
        sets:pulse.sets,
        direction:pulse.direction,
      }),
      intelligence:Object.freeze({
        marketHeat:null,
        volatility:null,
        heatingUp:Object.freeze([]),
        coolingDown:Object.freeze([]),
        movers:Object.freeze([]),
        reason:'phase_1b_not_calibrated',
      }),
    }));
    return true;
  } catch(error) {
    if(error instanceof TypeError){fail(res,400,'INVALID_MARKET_QUERY',error.message);return true;}
    throw error;
  }
}
