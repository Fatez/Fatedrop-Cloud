const TRACKS_BY_SET_CODE = Object.freeze({
  base1: Object.freeze(['first-edition', 'shadowless', 'unlimited']),
  base2: Object.freeze(['first-edition', 'unlimited']),
  base3: Object.freeze(['first-edition', 'unlimited']),
  base4: Object.freeze(['unlimited']),
  base5: Object.freeze(['first-edition', 'unlimited']),
  gym1: Object.freeze(['first-edition', 'unlimited']),
  gym2: Object.freeze(['first-edition', 'unlimited']),
  neo1: Object.freeze(['first-edition', 'unlimited']),
  neo2: Object.freeze(['first-edition', 'unlimited']),
  neo3: Object.freeze(['first-edition', 'unlimited']),
  neo4: Object.freeze(['first-edition', 'unlimited']),
});

const LABELS = Object.freeze({
  standard: 'Standard',
  unspecified: 'Edition not selected',
  'first-edition': '1st Edition',
  shadowless: 'Shadowless',
  unlimited: 'Unlimited',
});

function text(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function editionTracksForSet(set) {
  const codes = TRACKS_BY_SET_CODE[text(set?.code)] ?? Object.freeze(['standard']);
  return Object.freeze(codes.map((code) => Object.freeze({ code, label: LABELS[code] })));
}

export function requireEditionForSet(set, value) {
  const requested = text(value) || editionTracksForSet(set)[0].code;
  if (requested === 'unspecified') return requested;
  const track = editionTracksForSet(set).find((candidate) => candidate.code === requested);
  if (!track) {
    const error = new TypeError(`editionCode is not available for ${set?.name || 'this set'}`);
    error.code = 'SET_EDITION_NOT_AVAILABLE';
    throw error;
  }
  return track.code;
}

export function cardBelongsToEdition(card, set, editionCode) {
  const edition = requireEditionForSet(set, editionCode);
  const variant = text(card?.variantCode);
  if (edition === 'unspecified') return false;
  if (edition === 'first-edition') return variant.startsWith('first-edition-');
  if (edition === 'shadowless') return variant.startsWith('shadowless-');
  if (edition === 'unlimited') return !variant.startsWith('first-edition-') && !variant.startsWith('shadowless-');
  return !variant.startsWith('first-edition-') && !variant.startsWith('shadowless-');
}

export function isRegularBinderVariant(card) {
  const variant = text(card?.variantCode)
    .replace(/^first-edition-/, '')
    .replace(/^shadowless-/, '');
  return variant === 'standard' || variant === 'holo';
}

export function editionVariantCode(variantCode, editionCode) {
  const variant = text(variantCode);
  if (editionCode === 'first-edition' || editionCode === 'shadowless') return `${editionCode}-${variant}`;
  return variant;
}

export const __test = Object.freeze({ TRACKS_BY_SET_CODE });
