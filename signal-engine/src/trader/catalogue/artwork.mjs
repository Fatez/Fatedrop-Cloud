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
