import { createHash } from 'node:crypto';
import { normaliseSourceCardCandidate } from '../card-identity.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

export function normaliseComparableName(value) {
  return requireText(value, 'name')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normaliseCollectorNumber(value) {
  return requireText(value, 'collectorNumber')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function stableId(prefix, parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function conflict(field, left, right) {
  return Object.freeze({ status: 'conflict', field, left, right });
}

function setEvidenceContains(setMatch, cardEvidence) {
  return setMatch.evidence?.some(
    (entry) => entry.sourceName === cardEvidence.sourceName
      && entry.sourceRecordId === cardEvidence.sourceSetCode,
  ) === true;
}

function compactSetEvidence(evidence) {
  return Object.freeze({
    sourceName: evidence.sourceName,
    sourceRecordId: evidence.sourceRecordId,
    sourceSeriesCode: evidence.sourceSeriesCode ?? null,
    sourceUrl: evidence.sourceUrl ?? null,
    languageCode: evidence.languageCode ?? null,
  });
}

export function reconcileSetEvidence(left, right) {
  if (!left || !right) throw new TypeError('two set evidence records are required');
  if (left.sourceName === right.sourceName) {
    return Object.freeze({ status: 'insufficient', reason: 'independent_sources_required' });
  }

  if (left.tcgCode !== right.tcgCode) return conflict('tcgCode', left.tcgCode, right.tcgCode);

  const leftSetName = normaliseComparableName(left.setName);
  const rightSetName = normaliseComparableName(right.setName);
  if (leftSetName !== rightSetName) return conflict('setName', left.setName, right.setName);

  const leftSeriesName = normaliseComparableName(left.seriesName);
  const rightSeriesName = normaliseComparableName(right.seriesName);
  if (leftSeriesName !== rightSeriesName) return conflict('seriesName', left.seriesName, right.seriesName);

  if (left.releasedAt != null && right.releasedAt != null && left.releasedAt !== right.releasedAt) {
    return conflict('releasedAt', left.releasedAt, right.releasedAt);
  }

  if (left.printedTotal != null && right.printedTotal != null && left.printedTotal !== right.printedTotal) {
    return conflict('printedTotal', left.printedTotal, right.printedTotal);
  }

  // Total can move when an upstream source adds secrets/variants late. Treat a
  // disagreement as a conflict while both sources assert concrete totals.
  if (left.total != null && right.total != null && left.total !== right.total) {
    return conflict('total', left.total, right.total);
  }

  const anchors = [
    left.releasedAt != null && right.releasedAt != null,
    left.printedTotal != null && right.printedTotal != null,
    left.total != null && right.total != null,
  ].filter(Boolean).length;

  if (anchors < 2) {
    return Object.freeze({ status: 'insufficient', reason: 'not_enough_set_anchors' });
  }

  const releasedAt = left.releasedAt ?? right.releasedAt;
  const printedTotal = left.printedTotal ?? right.printedTotal;
  const total = left.total ?? right.total;
  const tcgCode = left.tcgCode;

  const canonicalSeriesId = stableId('fdseries', [tcgCode, leftSeriesName]);
  const canonicalSetId = stableId('fdset', [
    tcgCode,
    canonicalSeriesId,
    leftSetName,
    String(releasedAt ?? ''),
    String(printedTotal ?? ''),
  ]);

  return Object.freeze({
    status: 'matched',
    canonicalSeriesId,
    canonicalSetId,
    tcgCode,
    seriesName: left.seriesName,
    setName: left.setName,
    releasedAt,
    printedTotal,
    total,
    evidence: Object.freeze([
      compactSetEvidence(left),
      compactSetEvidence(right),
    ]),
  });
}

export function reconcileCardEvidence(variantRecord, corroboratingEvidence, setMatch) {
  if (!variantRecord || !corroboratingEvidence) {
    throw new TypeError('variant and corroborating card evidence are required');
  }
  if (!setMatch || setMatch.status !== 'matched') {
    return Object.freeze({ status: 'insufficient', reason: 'verified_set_crosswalk_required' });
  }
  if (variantRecord.status !== 'staged') {
    return Object.freeze({
      status: variantRecord.status,
      reason: variantRecord.reason ?? 'variant_source_not_staged',
      candidates: Object.freeze([]),
    });
  }

  const variantEvidence = variantRecord.baseEvidence;
  if (!variantEvidence || variantEvidence.variantEvidenceAvailable !== true) {
    return Object.freeze({ status: 'insufficient', reason: 'explicit_variant_evidence_required' });
  }
  if (!Array.isArray(variantRecord.variantEvidence) || variantRecord.variantEvidence.length === 0) {
    return Object.freeze({ status: 'insufficient', reason: 'explicit_variant_evidence_required' });
  }
  if (variantEvidence.sourceName === corroboratingEvidence.sourceName) {
    return Object.freeze({ status: 'insufficient', reason: 'independent_sources_required' });
  }

  if (!setEvidenceContains(setMatch, variantEvidence)) {
    return Object.freeze({ status: 'conflict', field: 'variantSourceSet', left: variantEvidence.sourceSetCode, right: setMatch.canonicalSetId });
  }
  if (!setEvidenceContains(setMatch, corroboratingEvidence)) {
    return Object.freeze({ status: 'conflict', field: 'corroboratingSourceSet', left: corroboratingEvidence.sourceSetCode, right: setMatch.canonicalSetId });
  }

  if (variantEvidence.tcgCode !== corroboratingEvidence.tcgCode) {
    return conflict('tcgCode', variantEvidence.tcgCode, corroboratingEvidence.tcgCode);
  }
  if (variantEvidence.tcgCode !== setMatch.tcgCode) {
    return conflict('setTcgCode', variantEvidence.tcgCode, setMatch.tcgCode);
  }
  if (variantEvidence.languageCode !== corroboratingEvidence.languageCode) {
    return conflict('languageCode', variantEvidence.languageCode, corroboratingEvidence.languageCode);
  }

  // Pokémon TCG API currently provides the independent base-printing evidence
  // for English. Other languages remain staged until they have an independent
  // language-appropriate corroborating source.
  if (variantEvidence.languageCode !== 'en') {
    return Object.freeze({ status: 'insufficient', reason: 'independent_language_source_required' });
  }

  const variantName = normaliseComparableName(variantEvidence.name);
  const corroboratingName = normaliseComparableName(corroboratingEvidence.name);
  if (variantName !== corroboratingName) {
    return conflict('cardName', variantEvidence.name, corroboratingEvidence.name);
  }

  const variantNumber = normaliseCollectorNumber(variantEvidence.collectorNumber);
  const corroboratingNumber = normaliseCollectorNumber(corroboratingEvidence.collectorNumber);
  if (variantNumber !== corroboratingNumber) {
    return conflict('collectorNumber', variantEvidence.collectorNumber, corroboratingEvidence.collectorNumber);
  }

  if (variantEvidence.printingCode !== corroboratingEvidence.printingCode) {
    return conflict('printingCode', variantEvidence.printingCode, corroboratingEvidence.printingCode);
  }

  const candidates = variantRecord.variantEvidence.map(({ variantCode, sourceVariantKey }) =>
    normaliseSourceCardCandidate({
      sourceName: variantEvidence.sourceName,
      sourceRecordId: variantEvidence.sourceRecordId,
      sourceVariantKey,
      sourceUrl: variantEvidence.sourceUrl,
      tcgCode: setMatch.tcgCode,
      seriesCode: setMatch.canonicalSeriesId,
      setCode: setMatch.canonicalSetId,
      collectorNumber: variantEvidence.collectorNumber,
      printingCode: variantEvidence.printingCode,
      variantCode,
      languageCode: variantEvidence.languageCode,
      name: variantEvidence.name,
      rarity: variantEvidence.rarity,
      supertype: variantEvidence.supertype,
    }),
  );

  return Object.freeze({
    status: 'matched',
    candidates: Object.freeze(candidates),
    corroboration: Object.freeze({
      sourceName: corroboratingEvidence.sourceName,
      sourceRecordId: corroboratingEvidence.sourceRecordId,
      sourceUrl: corroboratingEvidence.sourceUrl,
    }),
  });
}
