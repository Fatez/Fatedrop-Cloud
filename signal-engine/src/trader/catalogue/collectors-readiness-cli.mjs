import { PostgresStore } from '../../stores/postgres-store.mjs';
import { auditCollectorCatalogueFromStore } from './collector-readiness.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';

function argValue(name) {
  const prefix=`--${name}=`;
  const found=process.argv.slice(2).find((arg)=>arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const databaseUrl=String(process.env.DATABASE_URL||'').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const requested=argValue('tcg');
  const tcgCodes=requested ? [requested.trim().toLowerCase()] : SUPPORTED_TCG_CODES;
  const store=new PostgresStore(databaseUrl);
  const audits=[];
  for (const tcgCode of tcgCodes) {
    audits.push(await auditCollectorCatalogueFromStore(store,{tcgCode}));
  }
  const report={
    generatedAt:new Date().toISOString(),
    mode:'read-only',
    tcgs:audits.map((audit)=>audit.summary),
    sets:audits.flatMap((audit)=>audit.sets),
  };
  console.log(JSON.stringify(report,null,2));
}

main().catch((error)=>{
  console.error(JSON.stringify({ok:false,error:error?.message||String(error)},null,2));
  process.exitCode=1;
});
