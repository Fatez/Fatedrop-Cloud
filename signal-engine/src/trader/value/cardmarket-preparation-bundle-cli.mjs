import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCardmarketEvidenceBundle } from './cardmarket-preparation-bundle.mjs';

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) continue;
    options[match[1]] = match[2];
  }
  return options;
}

function requirePath(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return path.resolve(value);
}

function mappingKey(sourceRecordId, lane) {
  return `${String(sourceRecordId)}|${String(lane).trim().toLowerCase()}`;
}

export async function runCardmarketPreparationBundleCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sourcePath = requirePath(options.source, '--source=<price-guide.json>');
  const mappingsPath = requirePath(options.mappings, '--mappings=<exact-mappings.json>');
  const outputPath = options.output ? path.resolve(options.output) : null;

  const [sourceBytes, mappingsBytes] = await Promise.all([
    readFile(sourcePath),
    readFile(mappingsPath),
  ]);
  const payload = JSON.parse(sourceBytes.toString('utf8'));
  const mappingsPayload = JSON.parse(mappingsBytes.toString('utf8'));
  const mappings = Array.isArray(mappingsPayload) ? mappingsPayload : mappingsPayload.mappings;
  if (!Array.isArray(mappings)) throw new TypeError('mappings file must contain an array or { mappings: [] }');

  const exactMappings = new Map();
  for (const mapping of mappings) {
    if (!mapping || mapping.sourceName !== 'cardmarket') continue;
    const lane = mapping.priceGuideLane || mapping.sourcePriceLane || mapping.marketSegmentKey;
    if (!lane) continue;
    const key = mappingKey(mapping.sourceRecordId, lane);
    if (exactMappings.has(key)) {
      throw new Error(`duplicate exact mapping input for ${key}`);
    }
    exactMappings.set(key, mapping);
  }

  const result = await prepareCardmarketEvidenceBundle(payload, {
    sourceBytes,
    sourceLabel: path.basename(sourcePath),
    resolveMapping: ({ sourceRecordId, priceGuideLane }) => exactMappings.get(mappingKey(sourceRecordId, priceGuideLane)) ?? null,
  });

  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, output, { flag: 'wx' });
  else process.stdout.write(output);

  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCardmarketPreparationBundleCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
