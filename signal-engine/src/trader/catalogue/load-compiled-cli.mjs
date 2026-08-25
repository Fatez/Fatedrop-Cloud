import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresStore } from '../../stores/postgres-store.mjs';
import { loadCompiledCatalogueArtifact, validateCompiledCatalogueArtifact } from './bulk-loader.mjs';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function positiveInt(value, fallback, max) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > max) {
    throw new TypeError(`Expected integer between 100 and ${max}, received ${value}`);
  }
  return parsed;
}

async function main() {
  const artifactPath = argValue('artifact');
  if (!artifactPath) throw new Error('--artifact=<compiled-catalogue.json> is required');
  const artifact = JSON.parse(await readFile(resolve(artifactPath), 'utf8'));
  const validation = validateCompiledCatalogueArtifact(artifact);
  const write = process.argv.includes('--write');

  if (!write) {
    console.log(JSON.stringify({ mode: 'validate', artifactPath: resolve(artifactPath), validation }, null, 2));
    return;
  }

  if (!enabled(process.env.FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED)) {
    throw new Error('Bulk catalogue writes are disabled. Set FATE_TRADER_CATALOGUE_BULK_WRITE_ENABLED=true explicitly.');
  }
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for --write');
  const chunkSize = positiveInt(argValue('chunk-size'), 2000, 5000);

  const store = new PostgresStore(databaseUrl);
  const result = await loadCompiledCatalogueArtifact({ store, artifact, chunkSize });
  console.log(JSON.stringify({ mode: 'write', artifactPath: resolve(artifactPath), result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
