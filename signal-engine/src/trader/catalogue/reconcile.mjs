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

// Exact post-Batch-2 publisher naming conventions. Every entry pins both source
// IDs and both observed values; any source drift therefore fails closed.
const REVIEWED_SET_NAME_DIFFERENCES = new Map([
  ['tcgdex:base1|pokemontcg-api:base1', ['Base Set', 'Base']],
  ['tcgdex:hgss1|pokemontcg-api:hgss1', ['HeartGold SoulSilver', 'HeartGold & SoulSilver']],
  ['tcgdex:hgss2|pokemontcg-api:hgss2', ['Unleashed', 'HS—Unleashed']],
  ['tcgdex:hgss3|pokemontcg-api:hgss3', ['Undaunted', 'HS—Undaunted']],
  ['tcgdex:hgss4|pokemontcg-api:hgss4', ['Triumphant', 'HS—Triumphant']],
  ['tcgdex:fut2020|pokemontcg-api:fut20', ['Pokémon Futsal 2020', 'Pokémon Futsal Collection']],
  ['tcgdex:svp|pokemontcg-api:svp', ['SVP Black Star Promos', 'Scarlet & Violet Black Star Promos']],
  ['tcgdex:sve|pokemontcg-api:sve', ['Scarlet & Violet Energy', 'Scarlet & Violet Energies']],
]);

const REVIEWED_SERIES_NAME_DIFFERENCES = new Map([
  ['tcgdex:bog|pokemontcg-api:bp', ['E-Card', 'Other']],
  ['tcgdex:col1|pokemontcg-api:col1', ['Call of Legends', 'HeartGold & SoulSilver']],
  ['tcgdex:tk-ex-latia|pokemontcg-api:tk1a', ['Trainer kits', 'EX']],
  ['tcgdex:tk-ex-latio|pokemontcg-api:tk1b', ['Trainer kits', 'EX']],
  ['tcgdex:tk-ex-m|pokemontcg-api:tk2b', ['Trainer kits', 'EX']],
  ['tcgdex:tk-ex-p|pokemontcg-api:tk2a', ['Trainer kits', 'EX']],
  ['tcgdex:lc|pokemontcg-api:base6', ['Legendary Collection', 'Other']],
  ['tcgdex:2011bw|pokemontcg-api:mcd11', ["McDonald's Collection", 'Other']],
  ['tcgdex:2012bw|pokemontcg-api:mcd12', ["McDonald's Collection", 'Other']],
  ['tcgdex:2014xy|pokemontcg-api:mcd14', ["McDonald's Collection", 'Other']],
  ['tcgdex:2015xy|pokemontcg-api:mcd15', ["McDonald's Collection", 'Other']],
  ['tcgdex:2016xy|pokemontcg-api:mcd16', ["McDonald's Collection", 'Other']],
  ['tcgdex:2017sm|pokemontcg-api:mcd17', ["McDonald's Collection", 'Other']],
  ['tcgdex:2018sm|pokemontcg-api:mcd18', ["McDonald's Collection", 'Other']],
  ['tcgdex:2019sm|pokemontcg-api:mcd19', ["McDonald's Collection", 'Other']],
  ['tcgdex:2021swsh|pokemontcg-api:mcd21', ["McDonald's Collection", 'Other']],
  ['tcgdex:2022swsh|pokemontcg-api:mcd22', ["McDonald's Collection", 'Other']],
  ['tcgdex:np|pokemontcg-api:np', ['POP', 'NP']],
  ['tcgdex:ru1|pokemontcg-api:ru1', ['Platinum', 'Other']],
  ['tcgdex:si1|pokemontcg-api:si1', ['Neo', 'Other']],
]);

function reviewedPairDifference(map, left, right, leftValue, rightValue) {
  const key = `${left.sourceName}:${left.sourceRecordId}|${right.sourceName}:${right.sourceRecordId}`;
  const expected = map.get(key);
  return expected?.[0] === leftValue && expected?.[1] === rightValue;
}

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

  const acceptedDifferences = [];
  const leftSetName = normaliseComparableName(left.setName);
  const rightSetName = normaliseComparableName(right.setName);
  if (leftSetName !== rightSetName) {
    if (!reviewedPairDifference(REVIEWED_SET_NAME_DIFFERENCES, left, right, left.setName, right.setName)) {
      return conflict('setName', left.setName, right.setName);
    }
    acceptedDifferences.push(Object.freeze({
      field: 'setName', left: left.setName, right: right.setName, reason: 'reviewed_source_set_name_convention',
    }));
  }

  const leftSeriesName = normaliseComparableName(left.seriesName);
  const rightSeriesName = normaliseComparableName(right.seriesName);
  if (leftSeriesName !== rightSeriesName) {
    if (!reviewedPairDifference(REVIEWED_SERIES_NAME_DIFFERENCES, left, right, left.seriesName, right.seriesName)) {
      return conflict('seriesName', left.seriesName, right.seriesName);
    }
    acceptedDifferences.push(Object.freeze({
      field: 'seriesName', left: left.seriesName, right: right.seriesName, reason: 'reviewed_source_series_name_convention',
    }));
  }

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

export function reconcileChecklistPrintingEvidence(baseEvidence, corroboratingEvidence, setMatch) {
  if (!baseEvidence || !corroboratingEvidence) throw new TypeError('two base card evidence records are required');
  if (!setMatch || setMatch.status !== 'matched') {
    return Object.freeze({ status: 'insufficient', reason: 'verified_set_crosswalk_required' });
  }
  if (baseEvidence.sourceName === corroboratingEvidence.sourceName) {
    return Object.freeze({ status: 'insufficient', reason: 'independent_sources_required' });
  }
  if (!setEvidenceContains(setMatch, baseEvidence) || !setEvidenceContains(setMatch, corroboratingEvidence)) {
    return Object.freeze({ status: 'conflict', field: 'sourceSet', left: baseEvidence.sourceSetCode, right: corroboratingEvidence.sourceSetCode });
  }
  if (baseEvidence.tcgCode !== corroboratingEvidence.tcgCode || baseEvidence.tcgCode !== setMatch.tcgCode) {
    return conflict('tcgCode', baseEvidence.tcgCode, corroboratingEvidence.tcgCode);
  }
  if (baseEvidence.languageCode !== corroboratingEvidence.languageCode || baseEvidence.languageCode !== 'en') {
    return conflict('languageCode', baseEvidence.languageCode, corroboratingEvidence.languageCode);
  }
  if (normaliseComparableName(baseEvidence.name) !== normaliseComparableName(corroboratingEvidence.name)) {
    return conflict('cardName', baseEvidence.name, corroboratingEvidence.name);
  }
  if (normaliseCollectorNumber(baseEvidence.collectorNumber) !== normaliseCollectorNumber(corroboratingEvidence.collectorNumber)) {
    return conflict('collectorNumber', baseEvidence.collectorNumber, corroboratingEvidence.collectorNumber);
  }
  if (baseEvidence.printingCode !== corroboratingEvidence.printingCode) {
    return conflict('printingCode', baseEvidence.printingCode, corroboratingEvidence.printingCode);
  }
  return Object.freeze({
    status: 'matched',
    tcgCode: setMatch.tcgCode,
    seriesCode: setMatch.canonicalSeriesId,
    setCode: setMatch.canonicalSetId,
    collectorNumber: baseEvidence.collectorNumber,
    printingCode: baseEvidence.printingCode,
    name: baseEvidence.name,
    rarity: baseEvidence.rarity ?? corroboratingEvidence.rarity ?? null,
    supertype: baseEvidence.supertype ?? corroboratingEvidence.supertype ?? null,
    subtypes: Object.freeze([...(corroboratingEvidence.subtypes || [])]),
    nationalDexNumbers: Object.freeze([...(corroboratingEvidence.nationalDexNumbers || [])]),
    verificationBasis: Object.freeze({
      kind: 'base_printing_cross_source',
      sources: Object.freeze([
        compactSetEvidence({ ...baseEvidence, sourceRecordId: baseEvidence.sourceRecordId }),
        compactSetEvidence({ ...corroboratingEvidence, sourceRecordId: corroboratingEvidence.sourceRecordId }),
      ]),
    }),
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
