export function normaliseArtworkUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function tcgdexThumbnailUrl(value) {
  const base = normaliseArtworkUrl(value);
  if (!base) return null;
  const url = new URL(base);
  if (url.hostname !== 'assets.tcgdex.net') return base;
  if (/\.(?:png|webp|jpe?g)$/i.test(url.pathname)) return url.toString();
  url.pathname = `${url.pathname.replace(/\/$/, '')}/low.webp`;
  return url.toString();
}

export function pokemonTcgThumbnailUrl(setCode, collectorNumber) {
  const set = String(setCode || '').trim();
  const number = String(collectorNumber || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(set) || !/^[A-Za-z0-9._-]+$/.test(number)) return null;
  return normaliseArtworkUrl(`https://images.pokemontcg.io/${encodeURIComponent(set)}/${encodeURIComponent(number)}.png`);
}

export function selectChecklistArtworkEvidence(...evidences) {
  for (const evidence of evidences.flat().filter(Boolean)) {
    const thumbnailUrl = normaliseArtworkUrl(evidence.thumbnailUrl);
    if (!thumbnailUrl) continue;
    return Object.freeze({
      thumbnailUrl,
      sourceName: evidence.sourceName ?? null,
      sourceRecordId: evidence.sourceRecordId ?? null,
      sourceUrl: normaliseArtworkUrl(evidence.sourceUrl),
    });
  }
  return null;
}
