import { createHash, randomUUID } from 'node:crypto';
import { RAW_CONDITIONS } from '../collection/model.mjs';

export const BINDER_ITEM_STATUSES = Object.freeze([
  'available', 'in_negotiation', 'reserved', 'traded', 'withdrawn',
]);
export const TRADE_MODES = Object.freeze([
  'open', 'exact_wants_only', 'bundle_ok', 'one_for_one', 'negotiable',
]);

const TRANSITIONS = Object.freeze({
  available: new Set(['in_negotiation', 'reserved', 'traded', 'withdrawn']),
  in_negotiation: new Set(['available', 'reserved', 'traded', 'withdrawn']),
  reserved: new Set(['available', 'in_negotiation', 'traded', 'withdrawn']),
  traded: new Set([]),
  withdrawn: new Set(['available']),
});

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}
function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}
function stableId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}
function booleanValue(value, fallback) {
  return value == null ? fallback : Boolean(value);
}
function revision(value, fallback = 1) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError('revision must be a positive integer');
  return parsed;
}

export function makeTradeBinderId(userId, tcgId) {
  return stableId('fdbinder', [requireText(userId, 'userId'), requireText(tcgId, 'tcgId')]);
}
export function makeBinderItemId() {
  return `fdbinderitem_${randomUUID().replaceAll('-', '')}`;
}
export function makeBinderEventId() {
  return `fdbinderevent_${randomUUID().replaceAll('-', '')}`;
}

export function normalizeBinderItemInput(input = {}) {
  const collectionItemId = requireText(input.collectionItemId, 'collectionItemId');
  const tradeMode = requireText(input.tradeMode ?? 'open', 'tradeMode').toLowerCase();
  if (!TRADE_MODES.includes(tradeMode)) throw new TypeError('tradeMode is invalid');
  const visibility = requireText(input.visibility ?? 'private', 'visibility').toLowerCase();
  if (!['private', 'network'].includes(visibility)) throw new TypeError('visibility is invalid');
  const localTradeAllowed = booleanValue(input.localTradeAllowed, true);
  const postalTradeAllowed = booleanValue(input.postalTradeAllowed, true);
  if (!localTradeAllowed && !postalTradeAllowed) throw new TypeError('at least one trade method must be enabled');
  return Object.freeze({
    collectionItemId,
    tradeMode,
    visibility,
    localTradeAllowed,
    postalTradeAllowed,
    notes: optionalText(input.notes),
  });
}

export function normalizeBinderItemPatch(input = {}, current) {
  if (!current) throw new TypeError('current binder item is required');
  const normalized = normalizeBinderItemInput({
    collectionItemId: current.collectionItemId,
    tradeMode: input.tradeMode ?? current.tradeMode,
    visibility: input.visibility ?? current.visibility,
    localTradeAllowed: input.localTradeAllowed ?? current.localTradeAllowed,
    postalTradeAllowed: input.postalTradeAllowed ?? current.postalTradeAllowed,
    notes: Object.prototype.hasOwnProperty.call(input, 'notes') ? input.notes : current.notes,
  });
  return Object.freeze({ ...normalized, expectedRevision: revision(input.expectedRevision, current.revision) });
}

export function assertBinderStatusTransition(from, to) {
  const current = requireText(from, 'from').toLowerCase();
  const next = requireText(to, 'to').toLowerCase();
  if (!BINDER_ITEM_STATUSES.includes(current) || !BINDER_ITEM_STATUSES.includes(next)) {
    throw new TypeError('binder status is invalid');
  }
  if (current === next) return next;
  if (!TRANSITIONS[current].has(next)) {
    const error = new Error(`Invalid binder transition: ${current} -> ${next}`);
    error.code = 'INVALID_BINDER_TRANSITION';
    throw error;
  }
  return next;
}

export function normalizeWantConstraints(input = {}, current = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('want constraints are required');
  const copyState = requireText(input.copyState ?? current?.copyState ?? 'any', 'copyState').toLowerCase();
  if (!['any', 'raw', 'graded'].includes(copyState)) throw new TypeError('copyState is invalid');

  const minimumConditionCode = Object.prototype.hasOwnProperty.call(input, 'minimumConditionCode')
    ? optionalText(input.minimumConditionCode)?.toLowerCase() ?? null
    : current?.minimumConditionCode ?? null;
  if (minimumConditionCode != null && !RAW_CONDITIONS.includes(minimumConditionCode)) {
    throw new TypeError('minimumConditionCode is invalid');
  }

  const minimumGrade = Object.prototype.hasOwnProperty.call(input, 'minimumGrade')
    ? (input.minimumGrade == null ? null : Number(input.minimumGrade))
    : current?.minimumGrade ?? null;
  const maximumGrade = Object.prototype.hasOwnProperty.call(input, 'maximumGrade')
    ? (input.maximumGrade == null ? null : Number(input.maximumGrade))
    : current?.maximumGrade ?? null;
  for (const [field, value] of [['minimumGrade', minimumGrade], ['maximumGrade', maximumGrade]]) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new TypeError(`${field} is invalid`);
  }
  if (minimumGrade != null && maximumGrade != null && minimumGrade > maximumGrade) {
    throw new TypeError('minimumGrade cannot exceed maximumGrade');
  }
  if (copyState === 'raw' && (minimumGrade != null || maximumGrade != null)) {
    throw new TypeError('raw Wants cannot include grade constraints');
  }

  const companiesInput = Object.prototype.hasOwnProperty.call(input, 'acceptedGradingCompanies')
    ? input.acceptedGradingCompanies
    : current?.acceptedGradingCompanies ?? [];
  if (!Array.isArray(companiesInput)) throw new TypeError('acceptedGradingCompanies must be an array');
  const acceptedGradingCompanies = Object.freeze([...new Set(companiesInput.map((value) => requireText(value, 'acceptedGradingCompanies[]')))]);

  const localTradeAllowed = booleanValue(input.localTradeAllowed, current?.localTradeAllowed ?? true);
  const postalTradeAllowed = booleanValue(input.postalTradeAllowed, current?.postalTradeAllowed ?? true);
  if (!localTradeAllowed && !postalTradeAllowed) throw new TypeError('at least one trade method must be enabled');

  return Object.freeze({
    copyState,
    minimumConditionCode,
    minimumGrade,
    maximumGrade,
    acceptedGradingCompanies,
    localTradeAllowed,
    postalTradeAllowed,
    notes: Object.prototype.hasOwnProperty.call(input, 'notes') ? optionalText(input.notes) : current?.notes ?? null,
    expectedRevision: revision(input.expectedRevision, current?.revision ?? 1),
  });
}

export function publicBinderItem(item) {
  if (!item) return null;
  return Object.freeze({
    id: item.id,
    collectionItemId: item.collectionItemId,
    fateCardId: item.fateCardId,
    tradeQuantity: item.tradeQuantity,
    status: item.status,
    tradeMode: item.tradeMode,
    visibility: item.visibility,
    localTradeAllowed: item.localTradeAllowed,
    postalTradeAllowed: item.postalTradeAllowed,
    notes: item.notes ?? null,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}
