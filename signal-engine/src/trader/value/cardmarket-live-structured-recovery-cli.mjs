import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const VARIANT_TO_SOURCE = Object.freeze({ standard:'normal', holo:'holo' });
const VARIANT_TO_LANE = Object.freeze({ standard:'standard', holo:'holo' });

function stableId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24)}`;
}

function sourceKey(recordId, variant) { return `${recordId}|${variant}`; }

export async function buildStructuredRecovery({ db, tcgdexRepo }) {
  const repo = loadTcgdexRepositoryEvidence(tcgdexRepo, { includeCards:false });
  const [{ artifact: catalogueArtifact, products }, { artifact: priceArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);

  const { rows:setRows } = await db.query(`
    SELECT s.id AS set_id,s.name AS set_name,m.source_record_id AS tcgdex_set_id
    FROM fatedrop_card_sets s
    JOIN fatedrop_card_set_source_mappings m ON m.set_id=s.id AND m.source_name='tcgdex'
    WHERE s.verification_status='verified'`);

  const { rows:identityRows } = await db.query(`
    SELECT c.id,c.set_id,c.printing_id,c.variant_code,p.collector_number,p.name
    FROM fatedrop_card_identities c
    JOIN fatedrop_card_printings p ON p.id=c.printing_id
    WHERE c.verification_status='verified'
      AND c.language_code='en'
      AND c.variant_code=ANY($1::text[])
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=c.id
      )`, [['standard','holo']]);

  const { rows:existingMappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);

  const setEvidence = new Map();
  for (const row of setRows) {
    const sourceSet = repo.bySetId.get(row.tcgdex_set_id);
    const expansionId = Number(sourceSet?.cardmarketExpansionId);
    if (sourceSet && Number.isSafeInteger(expansionId) && expansionId>0) {
      setEvidence.set(row.set_id,{tcgdexSetId:row.tcgdex_set_id,setName:row.set_name,expansionId});
    }
  }

  const productIndex = new Map();
  let unparsableProducts = 0;
  for (const product of products) {
    const expansionId=Number(product.sourceExpansionId);
    if (!Number.isSafeInteger(expansionId) || expansionId<=0) continue;
    const parsed=parseCardmarketSingleProductName(product.name);
    if (!parsed) { unparsableProducts++; continue; }
    const key=`${expansionId}|${parsed.collectorNumber}|${normaliseComparableName(parsed.cardName)}`;
    const list=productIndex.get(key)||[];
    list.push({product,parsed});
    productIndex.set(key,list);
  }

  const existingSource=new Map(existingMappings.map(r=>[sourceKey(r.source_record_id,r.source_variant_key),r]));
  const existingCanonical=new Map(existingMappings.map(r=>[sourceKey(r.card_identity_id,r.source_variant_key),r]));
  const candidates=[], ambiguous=[], unresolved=[], conflicts=[];
  for (const row of identityRows) {
    const set=setEvidence.get(row.set_id);
    if (!set) {
      unresolved.push({cardIdentityId:row.id,setId:row.set_id,reason:'set_has_no_explicit_cardmarket_expansion_scope'});
      continue;
    }
    let collectorNumber;
    try { collectorNumber=normaliseCollectorNumber(row.collector_number); }
    catch {
      unresolved.push({cardIdentityId:row.id,setId:row.set_id,reason:'canonical_collector_number_invalid'});
      continue;
    }
    const key=`${set.expansionId}|${collectorNumber}|${normaliseComparableName(row.name)}`;
    const matches=productIndex.get(key)||[];
    if (matches.length===0) {
      unresolved.push({cardIdentityId:row.id,setName:set.setName,collectorNumber,cardName:row.name,variantCode:row.variant_code,reason:'no_exact_structured_product_in_scoped_expansion'});
      continue;
    }
    if (matches.length!==1) {
      ambiguous.push({cardIdentityId:row.id,setName:set.setName,collectorNumber,cardName:row.name,variantCode:row.variant_code,sourceRecordIds:matches.map(x=>String(x.product.sourceRecordId)),reason:'multiple_exact_structured_products_in_scoped_expansion'});
      continue;
    }

    const match=matches[0];
    const sourceVariantKey=VARIANT_TO_SOURCE[row.variant_code];
    const sourceRecordId=String(match.product.sourceRecordId);
    const sk=sourceKey(sourceRecordId,sourceVariantKey);
    const ck=sourceKey(row.id,sourceVariantKey);
    const priorSource=existingSource.get(sk);
    const priorCanonical=existingCanonical.get(ck);
    if (priorSource && priorSource.card_identity_id!==row.id) {
      conflicts.push({type:'source_owned_by_other_identity',sourceRecordId,sourceVariantKey,cardIdentityId:row.id,existingCardIdentityId:priorSource.card_identity_id});
      continue;
    }
    if (priorCanonical && String(priorCanonical.source_record_id)!==sourceRecordId) {
      conflicts.push({type:'identity_variant_owned_by_other_product',sourceRecordId,sourceVariantKey,cardIdentityId:row.id,existingSourceRecordId:priorCanonical.source_record_id});
      continue;
    }
    if (priorSource || priorCanonical) continue;

    candidates.push({
      id:stableId('fdcardmap',[row.id,'cardmarket',sourceRecordId,sourceVariantKey]),
      cardIdentityId:row.id,
      sourceRecordId,
      sourceVariantKey,
      sourceVersion:catalogueArtifact.sha256,
      proof:{
        method:'scoped_expansion_exact_collector_and_name',
        tcgdexSetId:set.tcgdexSetId,
        cardmarketExpansionId:set.expansionId,
        canonicalCollectorNumber:collectorNumber,
        canonicalCardName:row.name,
        cardmarketProductName:match.product.name,
        parsedSourceSetCode:match.parsed.sourceSetCode,
        parsedSourceCollectorNumber:match.parsed.sourceCollectorNumber,
      },
      variantCode:row.variant_code,
    });
  }

  const bySource=new Map(), byCanonical=new Map(), safe=[], candidateConflicts=[];
  for (const row of candidates) {
    const sk=sourceKey(row.sourceRecordId,row.sourceVariantKey);
    const ck=sourceKey(row.cardIdentityId,row.sourceVariantKey);
    const a=bySource.get(sk), b=byCanonical.get(ck);
    if (a && a.cardIdentityId!==row.cardIdentityId) {
      candidateConflicts.push({type:'candidate_source_conflict',key:sk});
      continue;
    }
    if (b && b.sourceRecordId!==row.sourceRecordId) {
      candidateConflicts.push({type:'candidate_canonical_conflict',key:ck});
      continue;
    }
    if (!a && !b) {
      bySource.set(sk,row);
      byCanonical.set(ck,row);
      safe.push(row);
    }
  }

  const priceByProduct=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));
  const priceable=safe.filter(row=>{
    const lane=VARIANT_TO_LANE[row.variantCode];
    const price=priceByProduct.get(row.sourceRecordId);
    return price && hasMeaningfulCardmarketLane(price,lane);
  });

  return {
    status:(conflicts.length||candidateConflicts.length)?'clean_subset_available':'clean',
    productionWrites:false,
    source:{
      tcgdexRevision:process.env.TCGDEX_REVISION||null,
      cardmarketCatalogueSha256:catalogueArtifact.sha256,
      cardmarketPriceGuideSha256:priceArtifact.sha256,
    },
    counts:{
      eligibleUnmappedNormalHoloIdentities:identityRows.length,
      scopedCanonicalSets:setEvidence.size,
      officialCardmarketProducts:products.length,
      unparsableOfficialProducts:unparsableProducts,
      structuredCandidates:candidates.length,
      safeExactMappings:safe.length,
      newlyMappedIdentities:new Set(safe.map(r=>r.cardIdentityId)).size,
      immediatelyPriceableIdentities:new Set(priceable.map(r=>r.cardIdentityId)).size,
      unresolved:unresolved.length,
      ambiguous:ambiguous.length,
      conflicts:conflicts.length+candidateConflicts.length,
    },
    safeMappings:safe,
    priceableIdentityIds:[...new Set(priceable.map(r=>r.cardIdentityId))].sort(),
    unresolved,
    ambiguous,
    conflicts:[...conflicts,...candidateConflicts],
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();
  const out=process.env.RUNNER_TEMP||'.';
  let report;
  try {
    report=await buildStructuredRecovery({db,tcgdexRepo:process.env.TCGDEX_REPO});
  } catch (error) {
    report={status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};
    process.exitCode=1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${out}/cardmarket-live-structured-recovery.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.counts||report));
  }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
