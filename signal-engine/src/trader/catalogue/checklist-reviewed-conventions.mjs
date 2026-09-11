import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from './reconcile.mjs';

function setMatchHasEvidence(setMatch, sourceName, sourceRecordId) {
  return setMatch?.status === 'matched'
    && setMatch.evidence?.some((entry) => entry.sourceName === sourceName && entry.sourceRecordId === sourceRecordId) === true;
}

function exactObserved(evidence, expected) {
  return evidence?.sourceName === expected.sourceName
    && evidence?.sourceSetCode === expected.sourceSetCode
    && evidence?.sourceRecordId === expected.sourceRecordId
    && evidence?.name === expected.name
    && normaliseCollectorNumber(evidence?.collectorNumber) === normaliseCollectorNumber(expected.collectorNumber);
}

const CHECKLIST_ONLY_CONVENTIONS = Object.freeze([
  Object.freeze({
    left: Object.freeze({ sourceName: 'tcgdex', sourceSetCode: 'neo4', sourceRecordId: 'neo4-96', name: "Thought Wave Machine (Rocket's Secret Machine)", collectorNumber: '96' }),
    right: Object.freeze({ sourceName: 'pokemontcg-api', sourceSetCode: 'neo4', sourceRecordId: 'neo4-96', name: 'Thought Wave Machine', collectorNumber: '96' }),
    rewrite: 'name',
    reason: 'reviewed_checklist_publisher_parenthetical_name_convention',
  }),
  ...['50a', '50b', '74a', '74b', '95a', '95b', '103a', '103b'].map((leftNumber) => {
    const rightNumber = leftNumber.replace(/[ab]$/i, '');
    const names = { 50: 'Golduck', 74: 'Drowzee', 95: 'Mr. Mime', 103: 'Porygon' };
    const name = names[Number(rightNumber)];
    return Object.freeze({
      left: Object.freeze({ sourceName: 'tcgdex', sourceSetCode: 'ecard2', sourceRecordId: `ecard2-${leftNumber}`, name, collectorNumber: leftNumber }),
      right: Object.freeze({ sourceName: 'pokemontcg-api', sourceSetCode: 'ecard2', sourceRecordId: `ecard2-${rightNumber}`, name, collectorNumber: rightNumber }),
      rewrite: 'collectorNumber',
      reason: 'reviewed_checklist_aquapolis_ab_printing_convention',
    });
  }),
  Object.freeze({
    left: Object.freeze({ sourceName: 'tcgdex', sourceSetCode: 'sv10.5b', sourceRecordId: 'sv10.5b-080', name: 'Antique Cover Fossil', collectorNumber: '080' }),
    right: Object.freeze({ sourceName: 'pokemontcg-api', sourceSetCode: 'zsv10pt5', sourceRecordId: 'zsv10pt5-80', name: 'Antique Cover Fossil', collectorNumber: '60' }),
    rewrite: 'collectorNumber',
    reason: 'reviewed_checklist_publisher_record_number_error',
  }),
]);

// Binder membership has a deliberately narrower evidence lane than exact identity
// matching. These reviewed conventions may corroborate a base printing only; they
// must never be fed into reconcileCardEvidence or used to manufacture a finish.
export function reviewedChecklistCorroboration(setMatch, left, right) {
  if (!left || !right || left.sourceName === right.sourceName) return null;
  const convention = CHECKLIST_ONLY_CONVENTIONS.find((entry) => exactObserved(left, entry.left) && exactObserved(right, entry.right));
  if (!convention) return null;
  if (!setMatchHasEvidence(setMatch, convention.left.sourceName, convention.left.sourceSetCode)
    || !setMatchHasEvidence(setMatch, convention.right.sourceName, convention.right.sourceSetCode)) return null;
  if (left.tcgCode !== right.tcgCode || left.languageCode !== right.languageCode || left.languageCode !== 'en') return null;
  if (left.printingCode !== right.printingCode) return null;

  const adjusted = { ...right };
  const acceptedDifference = {
    field: convention.rewrite === 'name' ? 'cardName' : 'collectorNumber',
    left: convention.rewrite === 'name' ? left.name : left.collectorNumber,
    right: convention.rewrite === 'name' ? right.name : right.collectorNumber,
    reason: convention.reason,
  };
  if (convention.rewrite === 'name') adjusted.name = left.name;
  else adjusted.collectorNumber = left.collectorNumber;

  if (normaliseComparableName(adjusted.name) !== normaliseComparableName(left.name)
    || normaliseCollectorNumber(adjusted.collectorNumber) !== normaliseCollectorNumber(left.collectorNumber)) return null;

  return Object.freeze({
    evidence: Object.freeze(adjusted),
    acceptedDifferences: Object.freeze([Object.freeze(acceptedDifference)]),
  });
}
