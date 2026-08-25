import { createHash } from 'node:crypto';

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

function stableId(prefix, parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function conflict(field, left, right) {
  return Object.freeze({ status: 'conflict', field, left, right });
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
      Object.freeze({ sourceName: left.sourceName, sourceRecordId: left.sourceRecordId }),
      Object.freeze({ sourceName: right.sourceName, sourceRecordId: right.sourceRecordId }),
    ]),
  });
}
