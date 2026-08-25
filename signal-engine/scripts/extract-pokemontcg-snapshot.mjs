import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const repoRoot = resolve(argValue('repo') || 'vendor/pokemon-tcg-data');
  const outputPath = resolve(argValue('out') || 'pokemontcg-snapshot-en.json');
  const sets = await readJson(join(repoRoot, 'sets', 'en.json'));
  if (!Array.isArray(sets)) throw new TypeError('Pokémon TCG sets/en.json must contain an array');

  const cardsDir = join(repoRoot, 'cards', 'en');
  const files = (await readdir(cardsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cardsBySet = {};
  let totalCards = 0;

  for (const file of files) {
    const rows = await readJson(join(cardsDir, file.name));
    if (!Array.isArray(rows)) throw new TypeError(`Pokémon TCG card file must contain an array: ${file.name}`);
    const fallbackSetId = basename(file.name, '.json');
    const setId = String(rows[0]?.set?.id || fallbackSetId).trim();
    if (!setId) throw new Error(`Unable to resolve set id for ${file.name}`);
    if (cardsBySet[setId]) throw new Error(`Duplicate Pokémon TCG card set snapshot: ${setId}`);
    cardsBySet[setId] = rows;
    totalCards += rows.length;
  }

  const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const snapshot = {
    format: 'fatedrop-pokemontcg-snapshot-v1',
    meta: {
      source: 'PokemonTCG/pokemon-tcg-data',
      commit,
      language: 'en',
      generatedAt: new Date().toISOString(),
    },
    counts: { sets: sets.length, cardSetFiles: files.length, cards: totalCards },
    sets,
    cardsBySet,
  };

  await writeFile(outputPath, JSON.stringify(snapshot));
  console.log(JSON.stringify({ outputPath, meta: snapshot.meta, counts: snapshot.counts }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
