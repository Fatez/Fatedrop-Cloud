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

const SOURCE_VARIANT = Object.freeze({ standard:'normal', holo:'holo', 'reverse-holo':'reverse' });
const PRICE_LANE = Object.freeze({ standard:'standard', holo:'holo' });

function stableId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24)}`;
}
function key(...parts) { return parts.join('|'); }

export async function buildStructuredRecovery({ db, tcgdexRepo }) {
  const repo = loadTcgdexRepositoryEvidence(tcgdexRepo, { includeCards:false });
  const [{ artifact: catalogueArtifact, products }, { artifact: priceArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const priceByProduct = new Map(snapshot.priceGuides.map(row => [String(row.idProduct), row]));

  const { rows: sets } = await db.query(`
    SELECT s.id,s.name,m.source_record_id AS tcgdex_set_id
    FROM fatedrop_card_sets s
    JOIN fatedrop_card_set_source_mappings m ON m.set_id=s.id AND m.source_name='tcgdex'
    WHERE s.verification_status='verified'`);
  const { rows: identities } = await db.query(`
    SELECT c.id,c.set_id,c.printing_id,c.variant_code,p.collector_number,p.name
    FROM fatedrop_card_identities c
    JOIN fatedrop_card_printings p ON p.id=c.printing_id
    WHERE c.verification_status='verified' AND c.language_code='en'`);
  const { rows: existing } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);

  const existingByIdentity = new Map(existing.map(row => [row.card_identity_id, row]));
  const existingBySource = new Map(existing.map(row => [key(row.source_record_id,row.source_variant_key), row]));
  const setScope = new Map();
  const unresolvedSets = [];
  for (const row of sets) {
    const evidence = repo.bySetId.get(row.tcgdex_set_id) || null;
    const expansionId = Number(evidence?.cardmarketExpansionId);
    if (!evidence || !Number.isSafeInteger(expansionId) || expansionId <= 0) {
      unresolvedSets.push({setId:row.id,setName:row.name,tcgdexSetId:row.tcgdex_set_id,reason:!evidence?'tcgdex_set_missing':'no_explicit_cardmarket_expansion'});
      continue;
    }
    setScope.set(row.id,{expansionId,tcgdexSetId:row.tcgdex_set_id,setName:row.name});
  }

  const productsByKey = new Map();
  let unparsableProducts = 0;
  for (const product of products) {
    const expansionId = Number(product.sourceExpansionId);
    if (!Number.isSafeInteger(expansionId) || expansionId <= 0) continue;
    const parsed = parseCardmarketSingleProductName(product.name);
    if (!parsed) { unparsableProducts += 1; continue; }
    const k = key(expansionId,parsed.collectorNumber,normaliseComparableName(parsed.cardName));
    const arr = productsByKey.get(k) || [];
    arr.push({product,parsed});
    productsByKey.set(k,arr);
  }

  const candidates = [];
  const unresolved = [];
  const ambiguous = [];
  for (const identity of identities) {
    if (existingByIdentity.has(identity.id)) continue;
    const scope = setScope.get(identity.set_id);
    if (!scope) {
      unresolved.push({cardIdentityId:identity.id,setId:identity.set_id,reason:'set_without_explicit_cardmarket_scope'});
      continue;
    }
    let collector;
    try { collector = normaliseCollectorNumber(identity.collector_number); }
    catch {
      unresolved.push({cardIdentityId:identity.id,setId:identity.set_id,reason:'invalid_collector_number'});
      continue;
    }
    const k = key(scope.expansionId,collector,normaliseComparableName(identity.name));
    const matches = productsByKey.get(k) || [];
    if (matches.length === 0) {
      unresolved.push({cardIdentityId:identity.id,setId:identity.set_id,setName:scope.setName,collectorNumber:collector,cardName:identity.name,variantCode:identity.variant_code,reason:'no_exact_structured_product_in_scoped_expansion'});
      continue;
    }
    if (matches.length !== 1) {
      ambiguous.push({cardIdentityId:identity.id,setId:identity.set_id,setName:scope.setName,collectorNumber:collector,cardName:identity.name,variantCode:identity.variant_code,sourceRecordIds:matches.map(x=>String(x.product.sourceRecordId)),reason:'multiple_exact_structured_products_in_scoped_expansion'});
      continue;
    }
    const sourceVariantKey = SOURCE_VARIANT[identity.variant_code];
    if (!sourceVariantKey) {
      unresolved.push({cardIdentityId:identity.id,reason:'unsupported_variant'});
      continue;
    }
    const match = matches[0];
    candidates.push({
      id: stableId('fdcardmap',[identity.id,'cardmarket',String(match.product.sourceRecordId),sourceVariantKey]),
      cardIdentityId: identity.id,
      sourceRecordId: String(match.product.sourceRecordId),
      sourceVariantKey,
      sourceVersion: catalogueArtifact.sha256,
      proof: {
        method:'scoped_expansion_exact_collector_and_name',
        tcgdexSetId:scope.tcgdexSetId,
        cardmarketExpansionId:scope.expansionId,
        collectorNumber:collector,
        canonicalCardName:identity.name,
        cardmarketProductName:match.product.name,
      },
      canonicalVariantCode:identity.variant_code,
    });
  }

  const sourceOwners = new Map();
  const canonicalOwners = new Map();
  const conflictSourceKeys = new Set();
  const conflictCanonicalKeys = new Set();
  const conflicts = [];
  for (const row of candidates) {
    const sk = key(row.sourceRecordId,row.sourceVariantKey);
    const ck = key(row.cardIdentityId,row.sourceVariantKey);
    const live = existingBySource.get(sk);
    if (live && live.card_identity_id !== row.cardIdentityId) {
      conflictSourceKeys.add(sk);
      conflicts.push({type:'source_owned_in_production',sourceRecordId:row.sourceRecordId,sourceVariantKey:row.sourceVariantKey,cardIdentityId:row.cardIdentityId,existingCardIdentityId:live.card_identity_id});
    }
    const sp = sourceOwners.get(sk);
    if (sp && sp.cardIdentityId !== row.cardIdentityId) {
      conflictSourceKeys.add(sk);
      conflicts.push({type:'candidate_source_conflict',sourceRecordId:row.sourceRecordId,sourceVariantKey:row.sourceVariantKey,left:sp.cardIdentityId,right:row.cardIdentityId});
    } else if (!sp) sourceOwners.set(sk,row);
    const cp = canonicalOwners.get(ck);
    if (cp && cp.sourceRecordId !== row.sourceRecordId) {
      conflictCanonicalKeys.add(ck);
      conflicts.push({type:'candidate_canonical_conflict',cardIdentityId:row.cardIdentityId,sourceVariantKey:row.sourceVariantKey,left:cp.sourceRecordId,right:row.sourceRecordId});
    } else if (!cp) canonicalOwners.set(ck,row);
  }

  const safeMappings = candidates.filter(row =>
    !conflictSourceKeys.has(key(row.sourceRecordId,row.sourceVariantKey))
    && !conflictCanonicalKeys.has(key(row.cardIdentityId,row.sourceVariantKey)));

  const safeNormalHolo = safeMappings.filter(row => ['normal','holo'].includes(row.sourceVariantKey));
  const priceable = safeNormalHolo.filter(row => {
    const lane = PRICE_LANE[row.canonicalVariantCode];
    const price = priceByProduct.get(row.sourceRecordId);
    return price && hasMeaningfulCardmarketLane(price,lane);
  });

  return {
    format:'fatedrop-live-structured-cardmarket-recovery-v1',
    status:'dry_run_complete',
    productionWrites:false,
    provenance:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogueArtifact.sha256,cardmarketPriceGuideSha256:priceArtifact.sha256},
    counts:{
      verifiedEnglishIdentities:identities.length,
      existingMappedIdentities:new Set(existing.map(x=>x.card_identity_id)).size,
      previouslyUnmapped:identities.length-new Set(existing.map(x=>x.card_identity_id)).size,
      scopedSets:setScope.size,
      unresolvedSets:unresolvedSets.length,
      structuredCandidates:candidates.length,
      safeExactMappings:safeMappings.length,
      safeNormalHoloMappings:safeNormalHolo.length,
      immediatelyPriceableNormalHolo:priceable.length,
      safeReverseMappings:safeMappings.filter(x=>x.sourceVariantKey==='reverse').length,
      unresolved:unresolved.length,
      ambiguous:ambiguous.length,
      conflicts:conflicts.length,
      unparsableOfficialProducts:unparsableProducts,
    },
    safeMappings,
    conflicts,
    ambiguous,
    unresolved,
    unresolvedSets,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db = await pool.connect();
  let report;
  try {
    report = await buildStructuredRecovery({db,tcgdexRepo:process.env.TCGDEX_REPO});
  } catch (error) {
    report = {status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    const out=process.env.RUNNER_TEMP||'.';
    await writeFile(`${out}/cardmarket-structured-live-recovery.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.counts||report));
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
