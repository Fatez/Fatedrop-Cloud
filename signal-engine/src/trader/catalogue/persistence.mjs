import { createHash } from 'node:crypto';
import { makeFatePrintingId, makeFateTcgId } from '../card-identity.mjs';

function stableId(prefix, parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function requireVerifiedAt(value) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('verifiedAt must be a positive timestamp');
  return value;
}

function tcgDisplayName(code) {
  if (code === 'pokemon') return 'Pokémon TCG';
  return String(code || '').trim().toUpperCase();
}

export function buildVerifiedCatalogueBatch({ setMatch, promotions, verifiedAt = Date.now() }) {
  const now = requireVerifiedAt(verifiedAt);
  if (!setMatch || setMatch.status !== 'matched') throw new TypeError('matched set evidence is required');
  if (!Array.isArray(promotions) || promotions.length === 0) throw new TypeError('verified card promotions are required');

  const identities = promotions.flatMap((promotion) => {
    if (promotion?.status !== 'verified' || !Array.isArray(promotion.identities)) {
      throw new TypeError('all catalogue promotions must be verified');
    }
    return promotion.identities;
  });
  if (!identities.length) throw new TypeError('verified card identities are required');

  const tcgId = makeFateTcgId(setMatch.tcgCode);
  const tcg = Object.freeze({
    id: tcgId,
    code: setMatch.tcgCode,
    name: tcgDisplayName(setMatch.tcgCode),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  const series = Object.freeze({
    id: setMatch.canonicalSeriesId,
    tcgId,
    code: setMatch.canonicalSeriesId,
    name: setMatch.seriesName,
    verificationStatus: 'verified',
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const set = Object.freeze({
    id: setMatch.canonicalSetId,
    tcgId,
    seriesId: setMatch.canonicalSeriesId,
    code: setMatch.canonicalSetId,
    name: setMatch.setName,
    printedTotal: setMatch.printedTotal ?? null,
    total: setMatch.total ?? null,
    releasedAt: setMatch.releasedAt ?? null,
    verificationStatus: 'verified',
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const setSourceMappings = Object.freeze((setMatch.evidence || []).map((evidence) => Object.freeze({
    id: stableId('fdsetmap', [set.id, evidence.sourceName, evidence.sourceRecordId]),
    setId: set.id,
    sourceName: evidence.sourceName,
    sourceRecordId: evidence.sourceRecordId,
    sourceSeriesCode: evidence.sourceSeriesCode ?? null,
    sourceUrl: evidence.sourceUrl ?? null,
    sourceVersion: null,
    firstObservedAt: now,
    lastObservedAt: now,
  })));

  const printingsById = new Map();
  const cardIdentities = [];
  const cardSourceMappings = [];
  const cardProvenance = [];

  for (const identity of identities) {
    if (identity.verificationStatus !== 'verified' || identity.verifiedAt == null) {
      throw new TypeError('only verified card identities can be persisted');
    }
    if (identity.tcgCode !== setMatch.tcgCode
      || identity.seriesCode !== setMatch.canonicalSeriesId
      || identity.setCode !== setMatch.canonicalSetId) {
      throw new TypeError('card identity does not belong to matched canonical set');
    }

    const printingId = makeFatePrintingId({
      tcgCode: identity.tcgCode,
      seriesCode: identity.seriesCode,
      setCode: identity.setCode,
      collectorNumber: identity.collectorNumber,
      printingCode: identity.printingCode,
    });

    if (!printingsById.has(printingId)) {
      printingsById.set(printingId, Object.freeze({
        id: printingId,
        tcgId,
        seriesId: setMatch.canonicalSeriesId,
        setId: setMatch.canonicalSetId,
        printingCode: identity.printingCode,
        collectorNumber: identity.collectorNumber,
        name: identity.name,
        rarity: identity.rarity ?? null,
        supertype: identity.supertype ?? null,
        subtypes: Object.freeze([]),
        nationalDexNumbers: Object.freeze([]),
        attributes: Object.freeze({}),
        verificationStatus: 'verified',
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      }));
    }

    cardIdentities.push(Object.freeze({
      id: identity.fateCardId,
      canonicalKey: identity.canonicalKey,
      tcgId,
      seriesId: setMatch.canonicalSeriesId,
      setId: setMatch.canonicalSetId,
      printingId,
      collectorNumber: identity.collectorNumber,
      variantCode: identity.variantCode,
      languageCode: identity.languageCode,
      verificationStatus: 'verified',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    }));

    cardSourceMappings.push(Object.freeze({
      id: stableId('fdcardmap', [identity.fateCardId, identity.sourceName, identity.sourceRecordId, identity.sourceVariantKey]),
      cardIdentityId: identity.fateCardId,
      sourceName: identity.sourceName,
      sourceRecordId: identity.sourceRecordId,
      sourceVariantKey: identity.sourceVariantKey,
      sourceUrl: identity.sourceUrl ?? null,
      sourceVersion: identity.sourceVersion ?? null,
      firstObservedAt: now,
      lastObservedAt: now,
    }));

    for (const evidence of identity.verificationBasis?.baseIdentitySources || []) {
      const explicitVariant = evidence.sourceName === identity.sourceName;
      cardProvenance.push(Object.freeze({
        id: stableId('fdcardprov', [identity.fateCardId, evidence.sourceName, evidence.sourceRecordId, explicitVariant ? identity.sourceVariantKey : 'base-printing']),
        cardIdentityId: identity.fateCardId,
        sourceName: evidence.sourceName,
        sourceRecordId: evidence.sourceRecordId,
        sourceVariantKey: explicitVariant ? identity.sourceVariantKey : 'base-printing',
        sourceUrl: evidence.sourceUrl ?? null,
        observedAt: now,
        evidenceStatus: 'accepted',
        evidenceJson: Object.freeze({
          kind: explicitVariant ? 'explicit_variant' : 'base_printing_corroboration',
          variantCode: explicitVariant ? identity.variantCode : null,
        }),
        createdAt: now,
      }));
    }
  }

  return Object.freeze({
    tcg,
    series,
    set,
    setSourceMappings,
    printings: Object.freeze([...printingsById.values()]),
    cardIdentities: Object.freeze(cardIdentities),
    cardSourceMappings: Object.freeze(cardSourceMappings),
    cardProvenance: Object.freeze(cardProvenance),
  });
}
