import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compilePokemonCatalogueSnapshots } from './snapshot-compiler.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function parseSetIds(value) {
  if (!value) return null;
  const ids = value.split(',').map((item) => item.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function main() {
  const tcgdexPath = argValue('tcgdex');
  const pokemonPath = argValue('pokemon');
  const outputPath = resolve(argValue('out') || 'fatedrop-pokemon-catalogue.json');
  if (!tcgdexPath) throw new Error('--tcgdex=<snapshot.json> is required');
  if (!pokemonPath) throw new Error('--pokemon=<snapshot.json> is required');

  const [tcgdexSnapshot, pokemonTcgSnapshot] = await Promise.all([
    readJson(tcgdexPath),
    readJson(pokemonPath),
  ]);
  const artifact = await compilePokemonCatalogueSnapshots({
    tcgdexSnapshot,
    pokemonTcgSnapshot,
    requestedTcgdexSetIds: parseSetIds(argValue('sets')),
    verifiedAt: Date.now(),
  });

  await writeFile(outputPath, JSON.stringify(artifact));
  console.log(JSON.stringify({
    outputPath,
    sources: artifact.sources,
    crosswalk: artifact.crosswalk,
    compilation: {
      requestedSetCount: artifact.compilation.requestedSetCount,
      verifiedSetCount: artifact.compilation.verifiedSetCount,
      rejectedSetCount: artifact.compilation.rejectedSetCount,
    },
    counts: artifact.counts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
