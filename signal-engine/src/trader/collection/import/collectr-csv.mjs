import { createHash } from 'node:crypto';
import { getTcgCapability, SUPPORTED_TCG_CODES } from '../../tcg-registry.mjs';

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function parsePositiveInt(value, fallback = 1) {
  const raw = text(value);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 999 ? n : null;
}

function parseCsvMatrix(csvText) {
  const input = String(csvText ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  row.push(field);
  if (row.some((value) => value !== '') || rows.length === 0) rows.push(row);
  return rows;
}

function field(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (value != null && text(value) !== '') return text(value);
  }
  return '';
}

function normalizeTcgCode(value) {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  const key = raw.replace(/[^a-z0-9]+/g, '');
  for (const code of SUPPORTED_TCG_CODES) {
    const capability = getTcgCapability(code);
    const candidates = [capability?.code, capability?.name, capability?.shortName]
      .filter(Boolean)
      .map((candidate) => String(candidate).toLowerCase().replace(/[^a-z0-9]+/g, ''));
    if (candidates.includes(key)) return code;
  }
  if (key === 'pokemon' || key === 'pokemontcg' || key === 'pokemontradingcardgame') return 'pokemon';
  if (key === 'onepiece' || key === 'onepiececardgame') return 'one-piece';
  if (key === 'disneylorcana' || key === 'lorcana') return 'lorcana';
  return null;
}

function normalizeCondition(value) {
  const key = text(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const map = {
    m:'mint', mint:'mint',
    nm:'near_mint', nearmint:'near_mint',
    lp:'lightly_played', lightlyplayed:'lightly_played',
    mp:'moderately_played', moderatelyplayed:'moderately_played',
    hp:'heavily_played', heavilyplayed:'heavily_played',
    dmg:'damaged', damaged:'damaged',
    unknown:'unknown',
  };
  return map[key] ?? 'unknown';
}

function stableRowKey(row, occurrence) {
  const parts = [
    row.tcgCode ?? '', row.setName, row.cardName, row.collectorNumber,
    row.variantLabel, row.languageCode ?? '', row.conditionCode,
    row.gradingCompany, row.gradeLabel, row.purchasePriceText, row.dateAdded,
  ];
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `collectr_${digest}_${occurrence}`;
}

export function parseCollectrCsv(csvText) {
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length < 2) return Object.freeze({ rows:Object.freeze([]), rejected:Object.freeze([]) });

  const headers = matrix[0].map(normalizeHeader);
  const parsed = [];
  const rejected = [];
  const occurrences = new Map();

  for (let index = 1; index < matrix.length; index += 1) {
    if (matrix[index].every((value) => text(value) === '')) continue;
    const raw = {};
    headers.forEach((header, column) => { if (header) raw[header] = matrix[index][column] ?? ''; });

    const game = field(raw,['Game','TCG','Trading Card Game']);
    const setName = field(raw,['Set','Set Name','Expansion']);
    const cardName = field(raw,['Name','Card Name','Product Name']);
    const collectorNumber = field(raw,['Card Number','Collector Number','Number','Card No']);
    const quantity = parsePositiveInt(field(raw,['Quantity','Qty']),1);
    const tcgCode = normalizeTcgCode(game);

    const candidate = {
      sourceName:'collectr',
      sourceRow:index + 1,
      tcgCode,
      sourceGame:game || null,
      setName,
      cardName,
      collectorNumber,
      rarity:field(raw,['Rarity']) || null,
      variantLabel:field(raw,['Variant','Finish','Printing']) || '',
      languageCode:field(raw,['Language','Language Code']).toLowerCase() || null,
      conditionCode:normalizeCondition(field(raw,['Condition'])),
      gradingCompany:field(raw,['Grading Company','Grader']) || '',
      gradeLabel:field(raw,['Grade']) || '',
      quantity,
      purchasePriceText:field(raw,['Purchase Price','Price Paid','Cost Basis']) || '',
      currencyCode:field(raw,['Currency','Currency Code']).toUpperCase() || null,
      dateAdded:field(raw,['Date Added','Added At','Purchase Date']) || '',
    };

    const errors = [];
    if (!tcgCode) errors.push('unsupported_or_missing_game');
    if (!setName) errors.push('missing_set');
    if (!cardName) errors.push('missing_card_name');
    if (!collectorNumber) errors.push('missing_card_number');
    if (quantity == null) errors.push('invalid_quantity');

    if (errors.length) {
      rejected.push(Object.freeze({ sourceRow:index + 1, errors:Object.freeze(errors), row:Object.freeze(candidate) }));
      continue;
    }

    const base = [candidate.tcgCode,candidate.setName,candidate.cardName,candidate.collectorNumber,candidate.variantLabel,candidate.languageCode ?? '',candidate.conditionCode,candidate.gradingCompany,candidate.gradeLabel,candidate.purchasePriceText,candidate.dateAdded].join('|');
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    parsed.push(Object.freeze({ ...candidate, sourceRecordKey:stableRowKey(candidate, occurrence) }));
  }

  return Object.freeze({ rows:Object.freeze(parsed), rejected:Object.freeze(rejected) });
}
