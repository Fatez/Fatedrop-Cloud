import { readFile } from 'node:fs/promises';
import { runOnePieceShadowScan } from './trader/one-piece/shadow-monitor.mjs';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

if (String(process.env.ONE_PIECE_SHADOW_OBSERVATION_ENABLED || '').toLowerCase() !== 'true') {
  throw new Error('ONE_PIECE_SHADOW_OBSERVATION_ENABLED=true is required');
}

const baselinePath = argument('baseline');
const baselineDocument = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
const previousBaseline = baselineDocument?.baseline ?? baselineDocument;
const report = await runOnePieceShadowScan({ previousBaseline });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
