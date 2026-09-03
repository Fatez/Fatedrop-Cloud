const PILOTS = Object.freeze({
  'collector-v1': Object.freeze({
    tcgCode: 'pokemon',
    languageCode: 'en',
    setNames: Object.freeze([
      'Scarlet & Violet',
      'Paldea Evolved',
      'Obsidian Flames',
      '151',
      'Paradox Rift',
    ]),
  }),
});

function normaliseSetName(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFKC')
    .toLocaleLowerCase('en-GB')
    .replace(/\s+/g, ' ');
}

export function cataloguePilotDefinition(key) {
  const cleanKey = String(key ?? '').trim();
  const pilot = PILOTS[cleanKey];
  if (!pilot) throw new Error(`Unknown catalogue pilot: ${cleanKey || '(empty)'}`);
  return pilot;
}

export function selectCataloguePilot(plan, key) {
  if (!plan || !Array.isArray(plan.matched)) throw new TypeError('crosswalk.matched is required');
  const pilot = cataloguePilotDefinition(key);
  const byName = new Map();
  for (const entry of plan.matched) {
    const setName = String(entry?.setMatch?.setName ?? '').trim();
    const normalised = normaliseSetName(setName);
    if (!normalised) continue;
    const rows = byName.get(normalised) || [];
    rows.push(entry);
    byName.set(normalised, rows);
  }

  const selected = [];
  const missing = [];
  const ambiguous = [];
  for (const requestedName of pilot.setNames) {
    const rows = byName.get(normaliseSetName(requestedName)) || [];
    if (rows.length === 0) {
      missing.push(requestedName);
      continue;
    }
    if (rows.length !== 1) {
      ambiguous.push({ setName: requestedName, matches: rows.map((row) => String(row?.tcgdexSetId ?? '')).filter(Boolean) });
      continue;
    }
    selected.push(rows[0]);
  }

  if (missing.length || ambiguous.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      ambiguous.length ? `ambiguous: ${ambiguous.map((row) => `${row.setName} (${row.matches.join('|') || 'unknown ids'})`).join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`Catalogue pilot ${key} is not fully present in the verified crosswalk (${details})`);
  }

  const uniqueIds = new Set(selected.map((entry) => String(entry?.tcgdexSetId ?? '').trim()));
  if (uniqueIds.size !== pilot.setNames.length) throw new Error(`Catalogue pilot ${key} did not resolve to five unique verified sets`);

  return Object.freeze({
    mode: 'pilot',
    pilotKey: String(key),
    pilot,
    requestedSetIds: Object.freeze(selected.map((entry) => String(entry.tcgdexSetId))),
    selected: Object.freeze(selected),
    crosswalk: Object.freeze({ ...plan, matched: Object.freeze(selected) }),
  });
}

export const CATALOGUE_PILOTS = PILOTS;
