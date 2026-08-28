import process from 'node:process';

import { createStore } from '../src/stores/index.mjs';
import { buildLiveCardmarketRehearsal } from '../src/trader/value/cardmarket-live-rehearsal.mjs';

function parseArgs(argv) {
  let limit = 50;
  let pretty = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--persist', '--write', '--apply', '--commit'].includes(arg)) {
      throw new Error(`${arg} is forbidden: Fate Value Cardmarket rehearsal is read-only`);
    }
    if (arg === '--limit') {
      const next = Number(argv[index + 1]);
      if (!Number.isSafeInteger(next) || next <= 0 || next > 200) {
        throw new TypeError('--limit must be an integer from 1 to 200');
      }
      limit = next;
      index += 1;
      continue;
    }
    if (arg === '--compact') {
      pretty = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { limit, pretty };
}

async function closeStore(store) {
  if (typeof store?.pool !== 'function') return;
  const pool = await store.pool();
  if (typeof pool?.end === 'function') await pool.end();
}

const options = parseArgs(process.argv.slice(2));
const store = createStore();

try {
  const report = await buildLiveCardmarketRehearsal({
    store,
    limit: options.limit,
  });
  process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
} finally {
  await closeStore(store);
}
