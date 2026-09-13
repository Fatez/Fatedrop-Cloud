import fs from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { buildEnglishPricingScope } from './english-pricing-bundle.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

function positiveStoredPriceSql(alias = 'o') {
  return `GREATEST(COALESCE(${alias}.market_price,0),COALESCE(${alias}.trend_price,0),COALESCE(${alias}.avg_1d,0),COALESCE(${alias}.avg_7d,0),COALESCE(${alias}.avg_30d,0)) > 0`;
}

function findBalancedEnd(source,start,openChar,closeChar){
  if(source[start]!==openChar)return -1;
  let depth=0,quote=null,escaped=false,lineComment=false,blockComment=false;
  for(let i=start;i<source.length;i++){
    const c=source[i],n=source[i+1];
    if(lineComment){if(c==='\n')lineComment=false;continue;}
    if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}
    if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}
    if(c==='/'&&n==='/'){lineComment=true;i++;continue;}
    if(c==='/'&&n==='*'){blockComment=true;i++;continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c===openChar)depth++;else if(c===closeChar){depth--;if(depth===0)return i;}
  }
  return -1;
}
function balancedAfter(source,regex,openChar,closeChar){const m=regex.exec(source);if(!m)return null;const start=source.indexOf(openChar,m.index+m[0].length-1);if(start<0)return null;const end=findBalancedEnd(source,start,openChar,closeChar);return end<0?null:source.slice(start,end+1);}
function arrayProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\[`),'[',']');}
function objectProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\{`),'{','}');}
function quotedProperty(source,property){if(!source)return null;const m=new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);return m?m[2].trim():null;}
function topLevelObjects(arraySource){if(!arraySource||arraySource[0]!=='[')return[];const out=[];let i=1;while(i<arraySource.length-1){const open=arraySource.indexOf('{',i);if(open<0)break;const end=findBalancedEnd(arraySource,open,'{','}');if(end<0)break;out.push(arraySource.slice(open,end+1));i=end+1;}return out;}
function namesFromArray(source,property){const block=arrayProperty(source,property);if(!block)return[];return topLevelObjects(block).map(obj=>quotedProperty(objectProperty(obj,'name'),'en')).filter(Boolean);}
function descriptorEvidence(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');return [...new Set([...namesFromArray(source,'attacks'),...namesFromArray(source,'abilities')].map(normaliseComparableName).filter(Boolean))].sort();}catch{return[];}}

async function main() {
  if (['MAPPING_WRITE','PRICE_WRITE','CORRECTION_WRITE'].some((key) => process.env[key] === 'true')) {
    throw new Error('URL evidence input export is read-only');
  }
  validateProductionTarget(process.env.DATABASE_URL);
  const output = path.resolve(process.env.URL_EVIDENCE_EXPORT_OUTPUT || path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-user-url-input-export'));
  await mkdir(output, { recursive: true });
  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const tcgdexCards = new Map();
  for (const set of repo.sets) for (const card of set.cards) tcgdexCards.set(card.tcgdexCardId, card);
  const [catalogue, guide] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: sourceIdentities } = await db.query(`
      SELECT i.id,i.set_id,i.variant_code,i.language_code,i.verification_status,
             p.name,p.collector_number,s.name AS set_name,rs.classifier_state,
             ARRAY(SELECT DISTINCT m.source_record_id FROM fatedrop_card_source_mappings m WHERE m.card_identity_id=i.id AND m.source_name='tcgdex' ORDER BY m.source_record_id) AS tcgdex_card_ids,
             ARRAY(SELECT DISTINCT sm.source_record_id FROM fatedrop_card_set_source_mappings sm WHERE sm.set_id=i.set_id AND sm.source_name='tcgdex' ORDER BY sm.source_record_id) AS tcgdex_set_ids
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE i.language_code='en' AND i.verification_status='verified'
        AND i.variant_code IN ('standard','holo')
      ORDER BY i.id`);
    const scope = buildEnglishPricingScope(sourceIdentities);
    const eligibleIds = new Set(scope.eligibleCards.map((row) => row.id));
    const { rows: pricedRows } = await db.query(`
      SELECT DISTINCT card_identity_id
      FROM fatedrop_market_observations o
      WHERE o.source_name='cardmarket' AND ${positiveStoredPriceSql('o')}
      ORDER BY card_identity_id`);
    const priced = new Set(pricedRows.map((row) => row.card_identity_id).filter((id) => eligibleIds.has(id)));
    const { rows: mappings } = await db.query(`
      SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,
             i.set_id,i.variant_code,p.name,p.collector_number,s.name AS set_name
      FROM fatedrop_card_source_mappings m
      JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      WHERE m.source_name='cardmarket' AND i.verification_status='verified' AND i.language_code='en'
      ORDER BY m.card_identity_id,m.source_variant_key,m.source_record_id`);
    const mappedIds = new Set(mappings.filter((row) => eligibleIds.has(row.card_identity_id)).map((row) => row.card_identity_id));
    const backlog = scope.eligibleCards.filter((row) => !priced.has(row.id)).map((row) => {
      const tcgdexCardIds = row.tcgdex_card_ids || [];
      const card = tcgdexCardIds.length === 1 ? tcgdexCards.get(tcgdexCardIds[0]) : null;
      return {
        cardIdentityId: row.id,
        setId: row.set_id,
        setName: row.set_name,
        cardName: row.name,
        collectorNumber: row.collector_number,
        finish: row.variant_code,
        queueSection: mappedIds.has(row.id) ? 'A' : 'B',
        tcgdexCardIds,
        tcgdexSetIds: row.tcgdex_set_ids || [],
        tcgdex: card ? {
          tcgdexCardId: card.tcgdexCardId,
          localId: card.localId,
          name: card.name,
          descriptors: descriptorEvidence(card),
          variants: card.variants.map((variant) => ({
            type: variant.type,
            subtype: variant.subtype,
            foil: variant.foil,
            stamp: variant.stamp,
            cardmarketProductId: variant.cardmarketProductId,
          })),
        } : null,
        mappings: mappings.filter((m) => m.card_identity_id === row.id).map((m) => ({
          id: m.id,
          sourceRecordId: String(m.source_record_id),
          sourceVariantKey: m.source_variant_key,
        })),
      };
    });
    const { rows: setMappings } = await db.query(`
      SELECT set_id,source_name,source_record_id,source_version
      FROM fatedrop_card_set_source_mappings
      WHERE source_name IN ('cardmarket','tcgdex')
      ORDER BY set_id,source_name,source_record_id`);
    const report = {
      status: 'audit_complete',
      productionWrites: false,
      source: {
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        cardmarketCatalogueSha256: catalogue.artifact.sha256,
        cardmarketPriceGuideSha256: guide.artifact.sha256,
        sourceSnapshotId: guide.snapshot.sourceSnapshotId,
      },
      pricingScope: {
        sourceCardCount: scope.sourceCardCount,
        eligibleCardCount: scope.eligibleCardCount,
        excludedInvalidCatalogueEntryCount: scope.excludedInvalidCatalogueEntryCount,
        excludedUnresolvedEvidenceCount: scope.excludedUnresolvedEvidenceCount,
        pricedCount: priced.size,
        backlogCount: backlog.length,
        sectionA: backlog.filter((row) => row.queueSection === 'A').length,
        sectionB: backlog.filter((row) => row.queueSection === 'B').length,
      },
      backlog,
      existingCardmarketMappings: mappings.map((row) => ({
        cardIdentityId: row.card_identity_id,
        setId: row.set_id,
        setName: row.set_name,
        cardName: row.name,
        collectorNumber: row.collector_number,
        finish: row.variant_code,
        sourceRecordId: String(row.source_record_id),
        sourceVariantKey: row.source_variant_key,
      })),
      setMappings,
    };
    const products = catalogue.products.map((product) => ({
      sourceRecordId: String(product.sourceRecordId),
      name: product.name,
      sourceExpansionId: product.sourceExpansionId,
      sourceMetacardId: product.sourceMetacardId,
      sourceCategoryId: product.sourceCategoryId,
    }));
    const priceGuides = guide.snapshot.priceGuides;
    await Promise.all([
      writeFile(path.join(output, 'production-backlog.json'), JSON.stringify(report)),
      writeFile(path.join(output, 'cardmarket-products.json'), JSON.stringify({ source: report.source, products })),
      writeFile(path.join(output, 'cardmarket-price-guide.json'), JSON.stringify({ source: report.source, priceGuides })),
    ]);
    await db.query('COMMIT');
    console.log(JSON.stringify({ ...report.pricingScope, products: products.length, priceGuideRows: priceGuides.length, tcgdexRevision: report.source.tcgdexRevision, productionWrites: false }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
