import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { runCardmarketReversePublicMarketCycle } from './cardmarket-reverse-public-market.mjs';

const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-reverse-public-cycle.json');

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const mode = process.env.CARDMARKET_REVERSE_MODE === 'persist' ? 'persist' : 'dry-run';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const store = { pool: async () => pool };
  let result;
  try {
    result = await runCardmarketReversePublicMarketCycle({
      store,
      mode,
      concurrency: Number(process.env.CARDMARKET_REVERSE_CONCURRENCY || 2),
      requestDelayMs: Number(process.env.CARDMARKET_REVERSE_REQUEST_DELAY_MS || 300),
      minOffers: Number(process.env.CARDMARKET_REVERSE_MIN_OFFERS || 3),
    });
    if (result.status !== 'complete' || Number(result.reconciliation?.unexplained || 0) !== 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    result = {
      status: 'blocked',
      productionWrites: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    status: result.status,
    productionWrites: result.productionWrites,
    reconciliation: result.reconciliation,
    persistence: result.persistence,
    error: result.error,
    failureSample: result.failures?.slice?.(0, 10),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
