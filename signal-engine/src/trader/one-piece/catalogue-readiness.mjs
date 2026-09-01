const SOURCE_ROLES = Object.freeze({
  CANONICAL_DATA: 'canonical_data',
  VERIFICATION_ONLY: 'verification_only',
});

const REQUIRED_SET_FIELDS = Object.freeze([
  'sourceName',
  'sourceRecordId',
  'marketCode',
  'languageCode',
  'seriesName',
  'setName',
  'sourceSetCode',
]);

const REQUIRED_CARD_FIELDS = Object.freeze([
  'sourceName',
  'sourceRecordId',
  'marketCode',
  'languageCode',
  'seriesName',
  'setName',
  'sourceSetCode',
  'collectorNumber',
  'printingCode',
  'name',
]);

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function comparable(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function finitePositiveInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function canonicalKey(record, kind) {
  const shared = [record.marketCode, record.languageCode, record.sourceSetCode].map(comparable);
  if (kind === 'set') return shared.join('|');
  return [...shared, record.collectorNumber, record.printingCode].map(comparable).join('|');
}

function conflictFingerprint(record, kind) {
  const shared = [record.seriesName, record.setName].map(comparable);
  if (kind === 'set') return [...shared, record.printedTotal ?? '', record.total ?? '', record.releasedAt ?? ''].join('|');
  return [...shared, comparable(record.name), comparable(record.rarity), record.variantEvidenceAvailable === true ? 'variant-evidence' : 'variant-unresolved'].join('|');
}

function expectedCount(sourceDeclarations, field) {
  const counts = [...new Set(sourceDeclarations
    .filter((source) => source.role === SOURCE_ROLES.CANONICAL_DATA)
    .map((source) => finitePositiveInteger(source[field]))
    .filter((value) => value != null))];
  return counts.length === 1 ? { value: counts[0], conflict: false } : { value: null, conflict: counts.length > 1 };
}

function assessRecords({ records, kind, sources, now, staleAfterSeconds }) {
  const required = kind === 'set' ? REQUIRED_SET_FIELDS : REQUIRED_CARD_FIELDS;
  const provisional = [];
  for (const record of records) {
    const sourceName = text(record?.sourceName);
    const sourceRecordId = text(record?.sourceRecordId);
    const source = sourceName ? sources.get(sourceName) : null;
    const missingFields = required.filter((field) => !text(record?.[field]));
    const reasons = [];
    let status = 'matched';

    if (!source) reasons.push('source_declaration_missing');
    else if (source.role !== SOURCE_ROLES.CANONICAL_DATA) reasons.push('verification_source_cannot_be_imported');
    else if (source.commercialUseApproved !== true || !text(source.licenceReference)) reasons.push('commercial_use_not_approved');
    if (missingFields.length > 0) reasons.push(...missingFields.map((field) => `${field}_missing`));
    if (kind === 'card' && record?.variantEvidenceAvailable !== true) reasons.push('variant_evidence_unresolved');

    const snapshotObservedAt = Number(source?.snapshotObservedAt);
    if (source && (!Number.isFinite(snapshotObservedAt) || snapshotObservedAt <= 0 || now - snapshotObservedAt > staleAfterSeconds)) {
      status = 'stale';
      reasons.push('source_snapshot_stale');
    } else if (reasons.some((reason) => ['commercial_use_not_approved', 'verification_source_cannot_be_imported'].includes(reason))) {
      status = 'rights_rejected';
    } else if (reasons.length > 0) {
      status = 'unresolved';
    }

    provisional.push({
      kind,
      sourceName,
      sourceRecordId,
      status,
      reasons,
      key: status === 'matched' ? canonicalKey(record, kind) : null,
      fingerprint: status === 'matched' ? conflictFingerprint(record, kind) : null,
    });
  }

  const matchedGroups = new Map();
  for (const item of provisional.filter((entry) => entry.status === 'matched')) {
    const group = matchedGroups.get(item.key) || [];
    group.push(item);
    matchedGroups.set(item.key, group);
  }
  for (const group of matchedGroups.values()) {
    if (new Set(group.map((entry) => entry.fingerprint)).size <= 1) continue;
    for (const item of group) {
      item.status = 'conflicting';
      item.reasons.push('canonical_identity_conflict');
    }
  }

  const counts = { matched: 0, unresolved: 0, conflicting: 0, stale: 0, rightsRejected: 0 };
  const matchedKeys = new Set();
  const results = provisional.map((item) => {
    if (item.status === 'matched') matchedKeys.add(item.key);
    if (item.status === 'rights_rejected') counts.rightsRejected += 1;
    else counts[item.status] += 1;
    return Object.freeze({
      kind: item.kind,
      sourceName: item.sourceName,
      sourceRecordId: item.sourceRecordId,
      status: item.status,
      reasons: Object.freeze(item.reasons),
    });
  });
  counts.matched = matchedKeys.size;
  return Object.freeze({ counts: Object.freeze(counts), results: Object.freeze(results) });
}

export function assessOnePieceCatalogueReadiness({
  sourceDeclarations = [],
  setEvidence = [],
  cardEvidence = [],
  now = Math.floor(Date.now() / 1000),
  staleAfterSeconds = 7 * 24 * 60 * 60,
} = {}) {
  const sources = new Map(sourceDeclarations.map((source) => [text(source?.sourceName), source]).filter(([name]) => name));
  const canonicalSources = sourceDeclarations.filter((source) => source?.role === SOURCE_ROLES.CANONICAL_DATA);
  const verificationSources = sourceDeclarations.filter((source) => source?.role === SOURCE_ROLES.VERIFICATION_ONLY);
  const approvedCanonicalSources = canonicalSources.filter((source) => source.commercialUseApproved === true && text(source.licenceReference));
  const expectedSets = expectedCount(sourceDeclarations, 'expectedSetCount');
  const expectedCards = expectedCount(sourceDeclarations, 'expectedCardCount');
  const sets = assessRecords({ records: setEvidence, kind: 'set', sources, now, staleAfterSeconds });
  const cards = assessRecords({ records: cardEvidence, kind: 'card', sources, now, staleAfterSeconds });

  const sourceRightsReady = approvedCanonicalSources.length > 0;
  const independentVerificationReady = verificationSources.some((source) => text(source.licenceReference));
  const snapshotsDeclaredComplete = approvedCanonicalSources.length > 0 && approvedCanonicalSources.every((source) => (
    source.scopeComplete === true
      && finitePositiveInteger(source.expectedSetCount) != null
      && finitePositiveInteger(source.expectedCardCount) != null
      && Number.isFinite(Number(source.snapshotObservedAt))
  ));
  const expectedCountsReady = !expectedSets.conflict && !expectedCards.conflict && expectedSets.value != null && expectedCards.value != null;
  const setCoverageReady = expectedCountsReady
    && sets.counts.matched === expectedSets.value
    && sets.counts.unresolved + sets.counts.conflicting + sets.counts.stale + sets.counts.rightsRejected === 0;
  const cardCoverageReady = expectedCountsReady
    && cards.counts.matched === expectedCards.value
    && cards.counts.unresolved + cards.counts.conflicting + cards.counts.stale + cards.counts.rightsRejected === 0;

  const gates = Object.freeze({
    sourceRightsReady,
    independentVerificationReady,
    snapshotsDeclaredComplete,
    expectedCountsReady,
    setCoverageReady,
    cardCoverageReady,
  });
  const catalogueGatePass = Object.values(gates).every(Boolean);

  return Object.freeze({
    contractVersion: 1,
    tcgCode: 'one-piece',
    mode: 'catalogue_shadow',
    catalogueGatePass,
    publicBrowseEnabled: false,
    retailerMonitoringEnabled: false,
    lifecycleAlertsEnabled: false,
    expected: Object.freeze({ sets: expectedSets.value, cards: expectedCards.value }),
    gates,
    sources: Object.freeze({
      canonicalData: canonicalSources.length,
      approvedCanonicalData: approvedCanonicalSources.length,
      verificationOnly: verificationSources.length,
    }),
    sets,
    cards,
  });
}

export const ONE_PIECE_CATALOGUE_SOURCE_ROLES = SOURCE_ROLES;
