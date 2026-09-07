import { PostgresStore } from '../../stores/postgres-store.mjs';
import { runRetailSingleNetworkCycle } from './retail-single-connector-registry.mjs';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function listArg(name) {
  return String(argValue(name) || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required to read the canonical catalogue');
  const write = process.argv.includes('--write');
  if (write && !enabled(process.env.FATEDROP_RETAIL_SINGLE_WRITE_ENABLED)) {
    throw new Error('Retail-single writes are disabled. Set FATEDROP_RETAIL_SINGLE_WRITE_ENABLED=true explicitly.');
  }
  const retailerIds = listArg('retailers');
  const result = await runRetailSingleNetworkCycle({
    store: new PostgresStore(databaseUrl),
    retailerIds: retailerIds.length ? retailerIds : null,
    write,
    concurrency: Number(argValue('concurrency') || 2),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failedCount) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
