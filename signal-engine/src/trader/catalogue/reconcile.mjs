import { createHash } from 'node:crypto';
import { normaliseCollectorNumber, normaliseSourceCardCandidate } from '../card-identity.mjs';

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

function allowsCelebrationsClassicCollectorAlias(setMatch, variantEvidence, corroboratingEvidence) {
  return variantEvidence.sourceName === 'tcgdex'
    && variantEvidence.sourceSetCode === 'cel25cc'
    && corroboratingEvidence.sourceName === 'pokemontcg-api'
    && corroboratingEvidence.sourceSetCode === 'cel25c'
    && setEvidenceContains(setMatch, variantEvidence)
    && setEvidenceContains(setMatch, corroboratingEvidence);
}

// Reviewed source-publication conventions from the post-24,084 census. These are
// deliberately exact: source pair + exact observed timestamps must all match.
// A provider change therefore fails closed instead of silently widening matching.
const REVIEWED_RELEASE_DATE_DIFFERENCES = new Map([
  ['tcgdex:sv10.5b|pokemontcg-api:zsv10pt5', [1752710400000, 1752796800000]],
  ['tcgdex:sm3|pokemontcg-api:sm3', [1501804800000, 1501891200000]],
  ['tcgdex:bwp|pokemontcg-api:bwp', [1303776000000, 1298937600000]],
  ['tcgdex:ex14|pokemontcg-api:ex14', [1156896000000, 1154390400000]],
  ['tcgdex:det1|pokemontcg-api:det1', [1553817600000, 1554422400000]],
  ['tcgdex:ex15|pokemontcg-api:ex15', [1162944000000, 1162339200000]],
  ['tcgdex:ex9|pokemontcg-api:ex9', [1115596800000, 1114905600000]],
  ['tcgdex:hgssp|pokemontcg-api:hsp', [1265846400000, 1265760000000]],
  ['tcgdex:ex13|pokemontcg-api:ex13', [1146614400000, 1146441600000]],
  ['tcgdex:ex12|pokemontcg-api:ex12', [1139788800000, 1138752000000]],
  ['tcgdex:ex16|pokemontcg-api:ex16', [1171670400000, 1170374400000]],
  ['tcgdex:sm9|pokemontcg-api:sm9', [1548892800000, 1548979200000]],
  ['tcgdex:ex10|pokemontcg-api:ex10', [1124668800000, 1122854400000]],
  ['tcgdex:sv10.5w|pokemontcg-api:rsv10pt5', [1752710400000, 1752796800000]],
]);

function reviewedReleaseDateDifference(left, right) {
  const key = `${left.sourceName}:${left.sourceRecordId}|${right.sourceName}:${right.sourceRecordId}`;
  const expected = REVIEWED_RELEASE_DATE_DIFFERENCES.get(key);
  return expected?.[0] === left.releasedAt && expected?.[1] === right.releasedAt;
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

  const acceptedDifferences = [];
  if (left.releasedAt != null && right.releasedAt != null && left.releasedAt !== right.releasedAt) {
    if (!reviewedReleaseDateDifference(left, right)) {
      return conflict('releasedAt', left.releasedAt, right.releasedAt);
    }
    acceptedDifferences.push(Object.freeze({
      field: 'releasedAt',
      left: left.releasedAt,
      right: right.releasedAt,
      reason: 'reviewed_source_release_date_convention',
    }));
  }

  if (left.printedTotal != null && right.printedTotal != null && left.printedTotal !== right.printedTotal) {
    return conflict('printedTotal', left.printedTotal, right.printedTotal);
  }

  // Upstream `total` is not a stable identity field: providers can count secret,
  // alternate-art, subset and other non-numbered records differently. Keep a
  // disagreement visible, but never invent which convention is canonical.
  const totalDisagrees = left.total != null && right.total != null && left.total !== right.total;
  if (totalDisagrees) {
    acceptedDifferences.push(Object.freeze({
      field: 'total',
      left: left.total,
      right: right.total,
      reason: 'source_counting_convention',
    }));
  }
  const frozenAcceptedDifferences = Object.freeze(acceptedDifferences);

  const anchors = [
    left.releasedAt != null && right.releasedAt != null,
    left.printedTotal != null && right.printedTotal != null,
    left.total != null && right.total != null && !totalDisagrees,
  ].filter(Boolean).length;

  if (anchors < 2) {
    return Object.freeze({ status: 'insufficient', reason: 'not_enough_set_anchors' });
  }

  const releasedAt = left.releasedAt ?? right.releasedAt;
  const printedTotal = left.printedTotal ?? right.printedTotal;
  const total = totalDisagrees ? null : (left.total ?? right.total);
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
    acceptedDifferences: frozenAcceptedDifferences,
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
  const acceptedCollectorAlias = allowsCelebrationsClassicCollectorAlias(setMatch, variantEvidence, corroboratingEvidence);
  if (variantNumber !== corroboratingNumber && !acceptedCollectorAlias) {
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
    acceptedDifferences: acceptedCollectorAlias && variantNumber !== corroboratingNumber
      ? Object.freeze([Object.freeze({
        field: 'collectorNumber',
        left: variantEvidence.collectorNumber,
        right: corroboratingEvidence.collectorNumber,
        reason: 'celebrations_classic_source_numbering_convention',
      })])
      : Object.freeze([]),
  });
}
