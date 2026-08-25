#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function english(value) {
  if (typeof value === 'string') return value.trim() || null;
  const text = value?.en;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function apiVariants(value) {
  if (Array.isArray(value)) {
    return {
      firstEdition: value.some((variant) => variant?.stamp?.some((stamp) => stamp === '1st-edition')),
      holo: value.some((variant) => variant?.type === 'holo'),
      normal: value.some((variant) => variant?.type === 'normal'),
      reverse: value.some((variant) => variant?.type === 'reverse'),
      wPromo: value.some((variant) => variant?.stamp?.some((stamp) => stamp === 'w-Promo')),
    };
  }
  return {
    firstEdition: typeof value?.firstEdition === 'boolean' ? value.firstEdition : false,
    holo: typeof value?.holo === 'boolean' ? value.holo : false,
    normal: typeof value?.normal === 'boolean' ? value.normal : true,
    reverse: typeof value?.reverse === 'boolean' ? value.reverse : false,
    wPromo: typeof value?.wPromo === 'boolean' ? value.wPromo : false,
  };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function importDefault(path) {
  return (await import(pathToFileURL(path).href)).default;
}

async function main() {
  const repoRoot = resolve(argValue('repo') || 'vendor/tcgdex-cards-database');
  const outputPath = resolve(argValue('out') || 'tcgdex-snapshot-en.json');
  const dataRoot = join(repoRoot, 'data');
  if (!await exists(dataRoot)) throw new Error(`TCGdex data directory not found: ${dataRoot}`);

  const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const rootEntries = await readdir(dataRoot, { withFileTypes: true });
  const seriesDirs = rootEntries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  const series = {};
  const sets = {};
  const cards = {};
  let skippedNoEnglish = 0;

  for (const seriesDir of seriesDirs) {
    const seriesModulePath = join(dataRoot, `${seriesDir.name}.ts`);
    if (!await exists(seriesModulePath)) continue;
    const sourceSeries = await importDefault(seriesModulePath);
    const seriesName = english(sourceSeries?.name);
    const seriesId = String(sourceSeries?.id || '').trim();
    if (!seriesName || !seriesId) continue;

    const setDirPath = join(dataRoot, seriesDir.name);
    const setFiles = (await readdir(setDirPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const seriesSetRefs = [];

    for (const setFile of setFiles) {
      const setModulePath = join(setDirPath, setFile.name);
      const sourceSet = await importDefault(setModulePath);
      const setName = english(sourceSet?.name);
      const setId = String(sourceSet?.id || '').trim();
      if (!setName || !setId) {
        skippedNoEnglish += 1;
        continue;
      }

      const cardDir = join(setDirPath, basename(setFile.name, '.ts'));
      const cardFiles = await exists(cardDir)
        ? (await readdir(cardDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
          .sort((a, b) => a.name.localeCompare(b.name))
        : [];

      const cardRefs = [];
      for (const cardFile of cardFiles) {
        const localId = basename(cardFile.name, '.ts');
        const sourceCard = await importDefault(join(cardDir, cardFile.name));
        const cardName = english(sourceCard?.name);
        if (!cardName) {
          skippedNoEnglish += 1;
          continue;
        }
        const cardId = `${setId}-${localId}`;
        const card = {
          id: cardId,
          localId,
          name: cardName,
          rarity: sourceCard?.rarity ?? null,
          category: sourceCard?.category ?? null,
          set: { id: setId, name: setName },
          variants: apiVariants(sourceCard?.variants),
        };
        cards[cardId] = card;
        cardRefs.push({ id: cardId, localId, name: cardName });
      }

      const official = Number.isInteger(sourceSet?.cardCount?.official) ? sourceSet.cardCount.official : null;
      const releaseDateValue = typeof sourceSet?.releaseDate === 'object'
        ? sourceSet.releaseDate?.en ?? Object.values(sourceSet.releaseDate || {})[0]
        : sourceSet?.releaseDate;
      const set = {
        id: setId,
        name: setName,
        serie: { id: seriesId, name: seriesName },
        cardCount: {
          official,
          total: Math.max(official ?? 0, cardRefs.length),
        },
        releaseDate: releaseDateValue ?? null,
        cards: cardRefs,
      };
      sets[setId] = set;
      seriesSetRefs.push({ id: setId, name: setName });
    }

    series[seriesId] = { id: seriesId, name: seriesName, sets: seriesSetRefs };
  }

  const snapshot = {
    format: 'fatedrop-tcgdex-snapshot-v1',
    meta: {
      source: 'tcgdex/cards-database',
      commit,
      language: 'en',
      generatedAt: new Date().toISOString(),
    },
    counts: {
      series: Object.keys(series).length,
      sets: Object.keys(sets).length,
      cards: Object.keys(cards).length,
      skippedNoEnglish,
    },
    series,
    sets,
    cards,
  };
  await writeFile(outputPath, JSON.stringify(snapshot));
  console.log(JSON.stringify({ outputPath, meta: snapshot.meta, counts: snapshot.counts }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
