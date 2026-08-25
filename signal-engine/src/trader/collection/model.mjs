import { createHash, randomUUID } from 'node:crypto';

export const RAW_CONDITIONS = Object.freeze([
  'mint',
  'near_mint',
  'lightly_played',
  'moderately_played',
  'heavily_played',
  'damaged',
  'unknown',
]);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function boundedInt(value, field, { min = 0, max = 999 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function stableId(prefix, parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

export function makeCollectionId(userId, tcgId) {
  return stableId('fdcollection', [requireText(userId, 'userId'), requireText(tcgId, 'tcgId')]);
}

export function makeExactWantId(userId, fateCardId) {
  return stableId('fdwant', [requireText(userId, 'userId'), requireText(fateCardId, 'fateCardId')]);
}

export function makeCollectionItemId() {
  return `fditem_${randomUUID().replaceAll('-', '')}`;
}

export function makeCollectionEventId() {
  return `fdcolevent_${randomUUID().replaceAll('-', '')}`;
}

export function normalizeCollectionItemInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('collection item input is required');
  const fateCardId = requireText(input.fateCardId, 'fateCardId');
  const quantity = boundedInt(input.quantity ?? 1, 'quantity', { min: 1, max: 999 });
  const tradeQuantity = boundedInt(input.tradeQuantity ?? (input.availableToTrade ? quantity : 0), 'tradeQuantity', { min: 0, max: quantity });
  const copyState = requireText(input.copyState ?? 'raw', 'copyState').toLowerCase();
  if (!['raw', 'graded'].includes(copyState)) throw new TypeError('copyState must be raw or graded');

  let conditionCode = null;
  let grading = null;
  if (copyState === 'raw') {
    conditionCode = requireText(input.conditionCode ?? 'unknown', 'conditionCode').toLowerCase();
    if (!RAW_CONDITIONS.includes(conditionCode)) throw new TypeError('conditionCode is invalid');
    if (input.grading != null) throw new TypeError('raw collection items cannot include grading details');
  } else {
    if (quantity !== 1) throw new TypeError('graded collection items must have quantity 1');
    if (!input.grading || typeof input.grading !== 'object' || Array.isArray(input.grading)) {
      throw new TypeError('grading details are required for graded collection items');
    }
    const gradeValue = input.grading.gradeValue == null ? null : Number(input.grading.gradeValue);
    if (gradeValue != null && (!Number.isFinite(gradeValue) || gradeValue < 0)) throw new TypeError('grading.gradeValue is invalid');
    grading = Object.freeze({
      gradingCompany: requireText(input.grading.gradingCompany, 'grading.gradingCompany'),
      gradeLabel: requireText(input.grading.gradeLabel, 'grading.gradeLabel'),
      gradeValue,
      certificationNumber: optionalText(input.grading.certificationNumber),
      certificationStatus: 'unverified',
      verificationSource: null,
      verifiedAt: null,
    });
  }

  return Object.freeze({
    fateCardId,
    quantity,
    tradeQuantity,
    availableToTrade: tradeQuantity > 0,
    copyState,
    conditionCode,
    grading,
    notes: optionalText(input.notes),
  });
}

export function normalizeCollectionItemPatch(input, current) {
  if (!current) throw new TypeError('current collection item is required');
  const merged = {
    fateCardId: current.fateCardId,
    quantity: input?.quantity ?? current.quantity,
    tradeQuantity: input?.tradeQuantity ?? current.tradeQuantity,
    copyState: current.copyState,
    conditionCode: current.conditionCode,
    grading: current.grading ?? null,
    notes: Object.prototype.hasOwnProperty.call(input || {}, 'notes') ? input.notes : current.notes,
  };
  return normalizeCollectionItemInput(merged);
}

export function normalizeExactWantInput(fateCardId, input = {}) {
  return Object.freeze({
    fateCardId: requireText(fateCardId, 'fateCardId'),
    quantity: boundedInt(input.quantity ?? 1, 'quantity', { min: 1, max: 999 }),
    active: input.active !== false,
  });
}

export function publicCollectionItem(item) {
  if (!item) return null;
  return Object.freeze({
    id: item.id,
    fateCardId: item.fateCardId,
    quantity: item.quantity,
    tradeQuantity: item.tradeQuantity,
    availableToTrade: item.tradeQuantity > 0,
    copyState: item.copyState,
    conditionCode: item.conditionCode ?? null,
    grading: item.grading ?? null,
    notes: item.notes ?? null,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}
