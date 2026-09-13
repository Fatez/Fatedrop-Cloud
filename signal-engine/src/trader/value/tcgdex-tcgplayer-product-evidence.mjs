import fs from 'node:fs';

const positiveInteger = value => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export function extractTcgdexTcgplayerProductIds(source) {
  if (typeof source !== 'string' || !source.trim()) return [];
  const ids = new Set();
  const thirdPartyBlocks = source.matchAll(/\bthirdParty\s*:\s*\{([\s\S]*?)\}/g);
  for (const match of thirdPartyBlocks) {
    const body = match[1] || '';
    const tcgplayer = /\btcgplayer\s*:\s*(\d+)/.exec(body);
    const id = positiveInteger(tcgplayer?.[1]);
    if (id) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export function tcgdexTcgplayerProductIdsForCard(card) {
  const path = card?.sourcePath;
  if (!path || !fs.existsSync(path)) return [];
  return extractTcgdexTcgplayerProductIds(fs.readFileSync(path, 'utf8'));
}
