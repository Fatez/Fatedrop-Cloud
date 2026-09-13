import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const input = resolve(arg('input') || 'japanese-catalogue-acquisition.json');
  const output = resolve(arg('output') || 'japanese-catalogue-completeness.json');
  const mode = arg('mode', 'full');
  const acquisition = JSON.parse(await readFile(input, 'utf8'));
  const counts = acquisition?.counts || {};
  const sets = Array.isArray(acquisition?.sets) ? acquisition.sets : [];
  const setCodes = sets.map((row) => String(row?.nativeSetCode || '').trim()).filter(Boolean);
  const uniqueCodes = new Set(setCodes);
  const problems = [];

  if (acquisition?.format !== 'fatedrop-japanese-catalogue-acquisition-v1') problems.push('unsupported_acquisition_format');
  if (Number(counts.errors || 0) !== 0 || (acquisition.errors || []).length) problems.push('acquisition_errors_present');
  if (Number(counts.quarantinedSets || 0) !== 0 || (acquisition.quarantinedSetIds || []).length) problems.push('quarantined_sets_present');
  if (setCodes.length !== sets.length || uniqueCodes.size !== setCodes.length) problems.push('native_set_codes_missing_or_duplicated');
  if (Number(counts.exactCrosswalkSetsAcquired || 0) !== sets.length) problems.push('acquired_set_count_mismatch');

  if (mode === 'full') {
    const acquired = Number(counts.exactCrosswalkSetsAcquired || 0);
    const tcgdex = Number(counts.tcgdexManifestSets || 0);
    const scrydex = Number(counts.scrydexPhysicalExpansions || 0);
    if (!acquired || !tcgdex || !scrydex) problems.push('full_manifest_counts_missing');
    if (acquired !== tcgdex) problems.push(`tcgdex_union_gap:${acquired}/${tcgdex}`);
    if (acquired !== scrydex) problems.push(`scrydex_union_gap:${acquired}/${scrydex}`);
  } else if (mode === 'canary') {
    if (!sets.length) problems.push('empty_canary');
  } else {
    problems.push(`unsupported_mode:${mode}`);
  }

  const report = {
    status: problems.length ? 'blocked' : 'complete',
    mode,
    productionWrites: false,
    runId: acquisition?.runId || null,
    counts,
    setCount: sets.length,
    problems,
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) process.exitCode = 1;
}

await main();
