import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { runCardmarketPokemonMarketCycle } from './cardmarket-market-cycle.mjs';

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const output = process.env.RUNNER_TEMP || '.';
  const mode = process.env.CARDMARKET_MODE === 'persist' ? 'persist' : 'dry-run';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const store = { pool: async () => pool };
  let report = { status: 'started', mode, productionWrites: false };
  try {
    const result = await runCardmarketPokemonMarketCycle({ store, mode });
    report = {
      status: 'complete',
      mode,
      productionWrites: mode === 'persist',
      ...result,
    };
  } catch (error) {
    report = {
      status: 'blocked',
      mode,
      productionWrites: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  } finally {
    await pool.end();
    await writeFile(`${output}/cardmarket-production-cycle.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
