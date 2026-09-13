import { createHash } from 'node:crypto';
import { makeCanonicalCardKey, makeFateCardId, makeFatePrintingId, makeFateTcgId } from '../card-identity.mjs';
import { classifyVariant } from '../value/variant-resolution-ledger.mjs';

export const JAPANESE_ACQUISITION_FORMAT = 'fatedrop-japanese-catalogue-acquisition-v1';
export const JAPANESE_ARTIFACT_FORMAT = 'fatedrop-japanese-catalogue-v1';

const STATES = Object.freeze(['ACTIVE_PRICED', 'ACTIVE_UNPRICED', 'INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE']);
const MARKERS = new Set(['none', 'pokeball_reverse', 'masterball_reverse']);
const EDITIONS = new Set(['unspecified', 'first_edition', 'unlimited']);
const FINISHES = new Set(['standard', 'holo', 'reverse_holo']);

function text(value, field) {
  const out = String(value ?? '').trim();
  if (!out) throw new TypeError(`${field} is required`);
  return out;
}

function stableId(prefix, parts) {
  const digest = createHash('sha256').update(parts.map((v) => String(v ?? '')).join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function nfkc(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function comparable(value) {
  return nfkc(value).toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ');
}

function seriesComparable(value) {
  return nfkc(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normCode(value) {
  return nfkc(value).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function collectorToken(value) {
  const raw = nfkc(value).toUpperCase().replace(/\s+/g, '');
  return /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, '') : raw;
}

function releaseMs(value) {
  const raw = text(value, 'release_date');
  const m = raw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (!m) throw new Error(`unsupported Japanese release date: ${raw}`);
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ts)) throw new Error(`invalid Japanese release date: ${raw}`);
  return ts;
}

function thumbnailFromScrydex(card) {
  const images = Array.isArray(card?.images) ? card.images : [];
  for (const image of images) {
    if (String(image?.type || '').toLowerCase() !== 'front') continue;
    for (const key of ['small', 'medium', 'large']) {
      const url = String(image?.[key] || '').trim();
      if (url.startsWith('https://')) return url;
    }
  }
  return null;
}

function explicitScrydexVariant(name) {
  const raw = text(name, 'scrydex variant name');
  const compact = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const firstEdition = compact.includes('firstedition');
  const unlimited = compact.includes('unlimited');
  const edition = firstEdition ? 'first_edition' : unlimited ? 'unlimited' : 'unspecified';
  const markerType = compact.includes('masterball')
    ? 'masterball_reverse'
    : compact.includes('pokeball') ? 'pokeball_reverse' : 'none';

  let finish = null;
  if (markerType !== 'none') finish = 'reverse_holo';
  else if (compact.includes('reverse') && (compact.includes('holo') || compact.includes('foil'))) finish = 'reverse_holo';
  else if (compact.includes('holo') || compact.includes('foil')) finish = 'holo';
  else if (compact.includes('normal') || compact.includes('standard') || compact.includes('nonholo')) finish = 'standard';

  return finish ? Object.freeze({ finish, markerType, edition, rawLabel: raw }) : null;
}

function tcgdexExplicitVariants(card) {
  const value = card?.variants;
  const out = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const normalized = explicitScrydexVariant(entry);
        if (normalized) out.push({ ...normalized, rawLabel: entry });
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const label = entry.name ?? entry.type ?? entry.variant;
      if (label) {
        const normalized = explicitScrydexVariant(label);
        if (normalized) out.push({ ...normalized, rawLabel: String(label) });
      }
    }
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const first = value.firstEdition === true ? 'first_edition' : 'unspecified';
  const unlimited = value.unlimited === true ? 'unlimited' : 'unspecified';
  const editions = first !== 'unspecified' && unlimited !== 'unspecified' ? [first, unlimited] : [first !== 'unspecified' ? first : unlimited];
  const safeEditions = editions.length && editions[0] !== 'unspecified' ? editions : ['unspecified'];
  const add = (finish, markerType, rawLabel) => {
    for (const edition of safeEditions) out.push({ finish, markerType, edition, rawLabel });
  };
  if (value.normal === true) add('standard', 'none', 'normal');
  if (value.holo === true) add('holo', 'none', 'holo');
  if (value.reverse === true) add('reverse_holo', 'none', 'reverse');
  if (value.reverseHolo === true) add('reverse_holo', 'none', 'reverseHolo');
  if (value.pokeballReverse === true || value.pokeBallReverse === true) add('reverse_holo', 'pokeball_reverse', 'pokeballReverse');
  if (value.masterballReverse === true || value.masterBallReverse === true) add('reverse_holo', 'masterball_reverse', 'masterballReverse');
  return out;
}

function canonicalVariantCode({ finish, markerType = 'none', edition = 'unspecified' }) {
  if (!FINISHES.has(finish)) throw new Error(`unsupported finish: ${finish}`);
  if (!MARKERS.has(markerType)) throw new Error(`unsupported marker: ${markerType}`);
  if (!EDITIONS.has(edition)) throw new Error(`unsupported edition: ${edition}`);
  const root = finish.replaceAll('_', '-');
  const parts = [root];
  if (markerType === 'pokeball_reverse') parts.push('pokeball');
  if (markerType === 'masterball_reverse') parts.push('masterball');
  if (edition === 'first_edition') parts.push('1st-edition');
  if (edition === 'unlimited') parts.push('unlimited');
  return parts.join('+');
}

function candidateKey(candidate) {
  return `${candidate.finish}|${candidate.markerType}|${candidate.edition}`;
}

function baseCandidate(scrydexCard) {
  const rarity = String(scrydexCard?.rarity_code || '').trim().toUpperCase();
  // Candidate creation is not existence proof and never authorizes a price.
  const inherentlyHolo = new Set(['RR', 'SAR', 'UR', 'V', 'EX']);
  return {
    finish: inherentlyHolo.has(rarity) ? 'holo' : 'standard',
    markerType: 'none',
    edition: 'unspecified',
    rawLabel: `candidate_from_rarity:${rarity || 'unknown'}`,
    candidateOnly: true,
  };
}

function variantsForPair(tcgdexCard, scrydexCard) {
  const byKey = new Map();
  const unknownLabels = [];
  const add = (candidate, sourceName, sourceRecordId) => {
    const key = candidateKey(candidate);
    const current = byKey.get(key) || {
      finish: candidate.finish,
      markerType: candidate.markerType,
      edition: candidate.edition,
      evidence: [],
      rawLabels: new Set(),
      candidateOnly: true,
    };
    current.rawLabels.add(candidate.rawLabel);
    if (!candidate.candidateOnly) {
      current.candidateOnly = false;
      current.evidence.push({ sourceName, sourceRecordId, rawLabel: candidate.rawLabel });
    }
    byKey.set(key, current);
  };

  const scrydexVariants = Array.isArray(scrydexCard?.variants) ? scrydexCard.variants : [];
  for (const variant of scrydexVariants) {
    const rawLabel = variant?.name;
    if (!rawLabel) continue;
    const parsed = explicitScrydexVariant(rawLabel);
    if (!parsed) {
      unknownLabels.push({ provider: 'scrydex', sourceRecordId: scrydexCard.id, rawLabel: String(rawLabel) });
      continue;
    }
    add(parsed, 'scrydex', text(scrydexCard.id, 'scrydex card id'));
  }

  for (const parsed of tcgdexExplicitVariants(tcgdexCard)) {
    add(parsed, 'tcgdex', text(tcgdexCard.id, 'tcgdex card id'));
  }

  if (byKey.size === 0) add({ ...baseCandidate(scrydexCard), candidateOnly: true }, 'candidate', text(scrydexCard.id, 'scrydex card id'));

  return {
    variants: [...byKey.values()].map((entry) => ({ ...entry, rawLabels: [...entry.rawLabels].sort() })),
    unknownLabels,
  };
}

function exactCardPairs(entry) {
  const tcgdexCards = Array.isArray(entry.tcgdexCards) ? entry.tcgdexCards : [];
  const scrydexCards = Array.isArray(entry.scrydexCards) ? entry.scrydexCards : [];
  const bucket = new Map();
  for (const card of scrydexCards) {
    const token = collectorToken(card?.number);
    if (!token) throw new Error(`Scrydex card missing number: ${card?.id || 'unknown'}`);
    if (!bucket.has(token)) bucket.set(token, []);
    bucket.get(token).push(card);
  }

  const used = new Set();
  const pairs = [];
  const conflicts = [];
  for (const card of tcgdexCards) {
    const token = collectorToken(card?.localId);
    let candidates = bucket.get(token) || [];
    if (candidates.length > 1) {
      const sourceName = comparable(card?.name);
      candidates = candidates.filter((candidate) => comparable(candidate?.name) === sourceName);
    }
    if (candidates.length !== 1) {
      conflicts.push({
        tcgdexCardId: card?.id || null,
        localId: card?.localId || null,
        reason: candidates.length ? 'ambiguous_exact_card_crosswalk' : 'missing_exact_scrydex_card',
        candidateIds: candidates.map((candidate) => candidate?.id).filter(Boolean),
      });
      continue;
    }
    const match = candidates[0];
    const id = text(match.id, 'scrydex card id');
    if (used.has(id)) {
      conflicts.push({ tcgdexCardId: card?.id || null, scrydexCardId: id, reason: 'scrydex_card_reused' });
      continue;
    }
    used.add(id);
    pairs.push({ tcgdex: card, scrydex: match });
  }
  for (const card of scrydexCards) {
    const id = text(card.id, 'scrydex card id');
    if (!used.has(id)) conflicts.push({ scrydexCardId: id, reason: 'scrydex_card_without_tcgdex_pair' });
  }
  return { pairs, conflicts };
}

function snapshotMaps(acquisition) {
  const byProviderRecord = new Map();
  const rawBySha = {};
  const catalogueRows = [];
  const runId = text(acquisition.runId, 'runId');
  for (const snap of acquisition.snapshots || []) {
    const provider = text(snap.provider, 'snapshot provider');
    const locator = text(snap.sourceLocator, 'snapshot sourceLocator');
    const sha = text(snap.payloadSha256, 'snapshot payloadSha256').toLowerCase();
    const raw = String(snap.rawPayloadText ?? '');
    const actual = createHash('sha256').update(raw).digest('hex');
    if (actual !== sha) throw new Error(`snapshot hash mismatch: ${provider}:${locator}`);
    rawBySha[sha] = raw;
    if (snap.sourceRecordId) byProviderRecord.set(`${provider}|${snap.sourceRecordId}`, snap);
    catalogueRows.push({
      id: stableId('fdcatev', [runId, provider, locator, sha]),
      runId,
      provider,
      scopeType: snap.scopeType,
      sourceLocator: locator,
      sourceRecordId: snap.sourceRecordId ?? null,
      setCode: snap.setCode ?? null,
      observedAt: Number(snap.observedAt),
      payloadSha256: sha,
      artifactSha256: text(snap.canonicalSha256, 'snapshot canonicalSha256').toLowerCase(),
      rawPayloadText: raw,
      createdAt: Number(snap.observedAt),
    });
  }
  return { byProviderRecord, rawBySha, catalogueRows };
}

function cardSnapshot(acquisitionSet, maps, provider, recordId) {
  if (provider === 'tcgdex') return maps.byProviderRecord.get(`tcgdex|${recordId}`) || null;
  if (provider === 'scrydex') {
    const pointer = acquisitionSet.scrydexCardEvidence?.[recordId];
    if (!pointer) return null;
    return {
      provider: 'scrydex',
      sourceRecordId: recordId,
      sourceLocator: pointer.sourceLocator,
      observedAt: pointer.observedAt,
      payloadSha256: pointer.payloadSha256,
      rawPayloadText: maps.rawBySha[pointer.payloadSha256],
    };
  }
  return null;
}

function verificationStatus(state) {
  return state === 'ACTIVE_PRICED' || state === 'ACTIVE_UNPRICED' ? 'verified' : 'quarantined';
}

function buildSetRows(entry, acquisition, maps, { verifiedAt, reviewReference }) {
  const nativeCode = text(entry.nativeSetCode, 'nativeSetCode');
  if (normCode(entry.tcgdexSetId) !== normCode(nativeCode)) throw new Error(`native set code mismatch: ${entry.tcgdexSetId} vs ${nativeCode}`);
  const expansion = entry.scrydexExpansion;
  if (String(expansion?.language_code || '').toUpperCase() !== 'JA') throw new Error(`non-Japanese expansion ${nativeCode}`);
  if (expansion?.is_online_only === true) throw new Error(`online-only expansion is outside physical catalogue: ${nativeCode}`);

  const seriesName = text(expansion?.series, `${nativeCode}.series`);
  const seriesKey = seriesComparable(seriesName);
  const seriesId = stableId('fdseries', ['pokemon', seriesKey]);
  const setName = text(expansion?.name, `${nativeCode}.name`);
  const releasedAt = releaseMs(expansion?.release_date);
  const printedTotal = Number.isInteger(expansion?.printed_total) ? expansion.printed_total : null;
  const total = Number.isInteger(expansion?.total) ? expansion.total : null;
  if (!printedTotal || !total) throw new Error(`set counts missing: ${nativeCode}`);
  const setId = stableId('fdset', ['pokemon', seriesId, comparable(setName), String(releasedAt), String(printedTotal), 'ja', nativeCode]);

  const { pairs, conflicts } = exactCardPairs(entry);
  if (conflicts.length) return { status: 'rejected', nativeCode, conflicts };

  const tcgId = makeFateTcgId('pokemon');
  const rows = {
    tcgs: [{ id: tcgId, code: 'pokemon', name: 'Pokémon TCG', status: 'active', createdAt: verifiedAt, updatedAt: verifiedAt }],
    series: [{ id: seriesId, tcgId, code: seriesId, name: seriesName, verificationStatus: 'verified', verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt }],
    sets: [{ id: setId, tcgId, seriesId, code: nativeCode, name: setName, printedTotal, total, releasedAt, verificationStatus: 'verified', verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt }],
    setSourceMappings: [
      {
        id: stableId('fdsetmap', [setId, 'tcgdex-ja', entry.tcgdexSetId]),
        setId, sourceName: 'tcgdex-ja', sourceRecordId: entry.tcgdexSetId,
        sourceSeriesCode: entry.tcgdexSet?.serie?.id ?? entry.tcgdexSet?.series?.id ?? null,
        sourceUrl: `https://api.tcgdex.net/v2/ja/sets/${encodeURIComponent(entry.tcgdexSetId)}`,
        sourceVersion: maps.byProviderRecord.get(`tcgdex|${entry.tcgdexSetId}`)?.payloadSha256 ?? null,
        firstObservedAt: verifiedAt, lastObservedAt: verifiedAt,
      },
      {
        id: stableId('fdsetmap', [setId, 'scrydex-ja', entry.scrydexExpansionId]),
        setId, sourceName: 'scrydex-ja', sourceRecordId: entry.scrydexExpansionId,
        sourceSeriesCode: seriesName,
        sourceUrl: `https://api.scrydex.com/pokemon/v1/ja/expansions/${encodeURIComponent(entry.scrydexExpansionId)}`,
        sourceVersion: null, firstObservedAt: verifiedAt, lastObservedAt: verifiedAt,
      },
    ],
    printings: [], cardIdentities: [], cardSourceMappings: [], cardProvenance: [], variantSnapshots: [], variantReviews: [],
    variantStates: [], auditHolds: [], catalogueFlags: [], evidenceFlags: [],
  };

  const collectorMultiplicity = new Map();
  for (const pair of pairs) {
    const collector = text(pair.scrydex.printed_number, `${pair.scrydex.id}.printed_number`);
    collectorMultiplicity.set(collector, (collectorMultiplicity.get(collector) || 0) + 1);
  }

  for (const pair of pairs) {
    const tcgdexCard = pair.tcgdex;
    const scrydexCard = pair.scrydex;
    const collectorNumber = text(scrydexCard.printed_number, `${scrydexCard.id}.printed_number`);
    const duplicateCollector = collectorMultiplicity.get(collectorNumber) > 1;
    const printingCode = duplicateCollector ? `source-${normCode(scrydexCard.id).toLowerCase()}` : 'main';
    const printingId = makeFatePrintingId({ tcgCode: 'pokemon', seriesCode: seriesId, setCode: nativeCode, collectorNumber, printingCode });
    const thumbnailUrl = thumbnailFromScrydex(scrydexCard);
    const imageProbe = thumbnailUrl ? acquisition.imageProbes?.[thumbnailUrl] : null;
    const artworkOk = thumbnailUrl && (imageProbe == null || imageProbe.ok === true);

    rows.printings.push({
      id: printingId, tcgId, seriesId, setId, printingCode, collectorNumber,
      name: text(scrydexCard.name ?? tcgdexCard.name, `${scrydexCard.id}.name`),
      rarity: scrydexCard.rarity ?? null,
      supertype: scrydexCard.supertype ?? null,
      subtypes: Array.isArray(scrydexCard.subtypes) ? scrydexCard.subtypes : [],
      nationalDexNumbers: Array.isArray(scrydexCard.national_pokedex_numbers) ? scrydexCard.national_pokedex_numbers : [],
      attributes: {
        language: 'ja', nativeSetCode: nativeCode, rarityCode: scrydexCard.rarity_code ?? null,
        artwork: artworkOk ? { thumbnailUrl, sourceName: 'scrydex', sourceRecordId: scrydexCard.id, sourceUrl: thumbnailUrl } : null,
        artworkStatus: artworkOk ? 'verified' : 'missing_or_broken',
        sourceCardIds: { tcgdex: tcgdexCard.id, scrydex: scrydexCard.id },
      },
      verificationStatus: 'verified', verifiedAt, createdAt: verifiedAt, updatedAt: verifiedAt,
    });

    if (!thumbnailUrl || !artworkOk) {
      rows.evidenceFlags.push({
        id: stableId('fdevflag', [acquisition.runId, nativeCode, scrydexCard.id, thumbnailUrl ? 'broken_thumbnail' : 'missing_thumbnail']),
        runId: acquisition.runId,
        flagType: thumbnailUrl ? 'broken_thumbnail' : 'missing_thumbnail',
        provider: 'scrydex', setCode: nativeCode, sourceRecordId: scrydexCard.id, cardIdentityId: null,
        evidenceSha256: null, sourceLocator: thumbnailUrl, detail: imageProbe || {}, active: true,
        createdAt: verifiedAt, updatedAt: verifiedAt,
      });
    }

    const { variants, unknownLabels } = variantsForPair(tcgdexCard, scrydexCard);
    for (const unknown of unknownLabels) {
      rows.evidenceFlags.push({
        id: stableId('fdevflag', [acquisition.runId, nativeCode, unknown.provider, unknown.sourceRecordId, unknown.rawLabel]),
        runId: acquisition.runId, flagType: 'unrecognised_variant_label', provider: unknown.provider,
        setCode: nativeCode, sourceRecordId: unknown.sourceRecordId, cardIdentityId: null, evidenceSha256: null,
        sourceLocator: null, detail: { rawLabel: unknown.rawLabel }, active: true,
        createdAt: verifiedAt, updatedAt: verifiedAt,
      });
    }

    for (const variant of variants) {
      const variantCode = canonicalVariantCode(variant);
      const canonicalInput = { tcgCode: 'pokemon', seriesCode: seriesId, setCode: nativeCode, collectorNumber, printingCode, variantCode, languageCode: 'ja' };
      const canonicalKey = makeCanonicalCardKey(canonicalInput);
      const cardIdentityId = makeFateCardId(canonicalKey);

      const decisions = [];
      const scopedSnapshots = {};
      const externalFinishKeys = [];
      for (const evidence of variant.evidence) {
        const snap = cardSnapshot(entry, maps, evidence.sourceName, evidence.sourceRecordId);
        if (!snap?.payloadSha256 || typeof snap.rawPayloadText !== 'string') throw new Error(`missing raw snapshot for ${evidence.sourceName}:${evidence.sourceRecordId}`);
        scopedSnapshots[snap.payloadSha256] = snap.rawPayloadText;
        externalFinishKeys.push(evidence.rawLabel);
        decisions.push({
          cardIdentityId, finish: variant.finish, language: 'ja', edition: variant.edition, verdict: 'exists', basis: 'explicit_variant_record',
          reviewReference, sourceLocator: snap.sourceLocator, snapshotSha256: snap.payloadSha256, provider: evidence.sourceName,
          markerType: variant.markerType, observedFinish: evidence.rawLabel,
        });
      }

      const result = classifyVariant(
        { cardIdentityId, variantCode: variant.finish, language: 'ja', edition: variant.edition, externalFinishKeys },
        { decisions, snapshots: scopedSnapshots, prices: [], now: verifiedAt },
      );
      if (!STATES.includes(result.state)) throw new Error(`invalid state ${result.state}`);

      rows.cardIdentities.push({
        id: cardIdentityId, canonicalKey, tcgId, seriesId, setId, printingId, collectorNumber, variantCode, languageCode: 'ja',
        verificationStatus: verificationStatus(result.state),
        verifiedAt: result.state === 'ACTIVE_UNPRICED' || result.state === 'ACTIVE_PRICED' ? verifiedAt : null,
        createdAt: verifiedAt, updatedAt: verifiedAt,
      });

      for (const provider of ['tcgdex', 'scrydex']) {
        const recordId = provider === 'tcgdex' ? tcgdexCard.id : scrydexCard.id;
        rows.cardProvenance.push({
          id: stableId('fdcardprov', [cardIdentityId, provider, recordId, 'base-printing']),
          cardIdentityId, sourceName: `${provider}-ja`, sourceRecordId: recordId, sourceVariantKey: 'base-printing',
          sourceUrl: provider === 'tcgdex'
            ? `https://api.tcgdex.net/v2/ja/cards/${encodeURIComponent(recordId)}`
            : `https://api.scrydex.com/pokemon/v1/ja/cards/${encodeURIComponent(recordId)}`,
          observedAt: verifiedAt, evidenceStatus: 'accepted',
          evidenceJson: { kind: 'base_printing_corroboration', nativeSetCode: nativeCode, collectorNumber }, createdAt: verifiedAt,
        });
      }

      for (const decision of decisions) {
        const provider = decision.provider;
        const recordId = provider === 'tcgdex' ? tcgdexCard.id : scrydexCard.id;
        const snap = cardSnapshot(entry, maps, provider, recordId);
        const sourceVariantKey = `${variantCode}:${decision.observedFinish}`;
        rows.cardSourceMappings.push({
          id: stableId('fdcardmap', [cardIdentityId, provider, recordId, sourceVariantKey]),
          cardIdentityId, sourceName: `${provider}-ja`, sourceRecordId: recordId, sourceVariantKey,
          sourceUrl: decision.sourceLocator, sourceVersion: snap.payloadSha256,
          firstObservedAt: snap.observedAt, lastObservedAt: snap.observedAt,
        });
        rows.variantSnapshots.push({
          id: stableId('fdvarsnap', [provider, cardIdentityId, snap.payloadSha256]),
          cardIdentityId, provider, sourceLocator: snap.sourceLocator,
          requestFingerprint: stableId('request', [provider, snap.sourceLocator]),
          observedAt: snap.observedAt, payloadSha256: snap.payloadSha256, artifactSha256: snap.payloadSha256,
          rawPayloadText: snap.rawPayloadText, createdAt: verifiedAt,
        });
        rows.variantReviews.push({
          id: stableId('fdvarreview', [acquisition.runId, cardIdentityId, provider, variant.finish, variant.markerType, variant.edition]),
          cardIdentityId, finish: variant.finish, markerType: variant.markerType, language: 'ja', edition: variant.edition,
          provider, observedFinish: decision.observedFinish, verdict: 'exists', basis: 'explicit_variant_record',
          evidenceSnapshotSha256: snap.payloadSha256, evidenceReference: decision.sourceLocator,
          reviewReference, approvalId: reviewReference, reviewer: 'fatedrop-japanese-normalizer-v1',
          reviewedAt: verifiedAt, createdAt: verifiedAt,
        });
      }

      rows.variantStates.push({
        cardIdentityId, finish: variant.finish, markerType: variant.markerType, language: 'ja', edition: variant.edition,
        state: result.state, reason: result.reason, evidenceReferences: result.evidenceReferences, exactMappingVerified: false,
        currentPriceProvider: null, currentPriceProductId: null, currentPriceSubtype: null, currentPriceCurrency: null,
        currentPriceAmount: null, currentPriceObservedAt: null, priceSnapshotSha256: null,
        resolutionReference: reviewReference, lastClassifiedAt: verifiedAt, updatedAt: verifiedAt,
      });

      if (result.state === 'UNRESOLVED_EVIDENCE') {
        rows.auditHolds.push({
          id: stableId('fdvarhold', [acquisition.runId, cardIdentityId, variant.finish, variant.markerType, variant.edition]),
          cardIdentityId, finish: variant.finish, markerType: variant.markerType, language: 'ja', edition: variant.edition,
          reason: result.reason,
          details: { canonicalVariantCode: variantCode, candidateOnly: variant.candidateOnly, rawLabels: variant.rawLabels },
          evidenceReferences: result.evidenceReferences, active: true, createdAt: verifiedAt, updatedAt: verifiedAt,
        });
      }
    }
  }

  return { status: 'verified', nativeCode, rows, baseCards: pairs.length };
}

function mergeRows(target, source) {
  for (const [key, values] of Object.entries(source)) {
    if (!Array.isArray(values)) continue;
    if (!target[key]) target[key] = [];
    target[key].push(...values);
  }
}

function uniqueRows(rows, key = 'id') {
  const seen = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!id) throw new Error(`row missing ${key}`);
    const prior = seen.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error(`row collision ${id}`);
    seen.set(id, row);
  }
  return [...seen.values()];
}

export function compileJapaneseCatalogueAcquisition(acquisition, { verifiedAt = Date.now(), reviewReference } = {}) {
  if (acquisition?.format !== JAPANESE_ACQUISITION_FORMAT) throw new Error(`unsupported acquisition format: ${acquisition?.format}`);
  if (!reviewReference || typeof reviewReference !== 'string') throw new Error('reviewReference is required');
  if (!Number.isFinite(verifiedAt) || verifiedAt <= 0) throw new Error('verifiedAt must be positive');
  if ((acquisition.quarantinedSetIds || []).length) throw new Error('provider network quarantine present; production compilation blocked');
  if ((acquisition.errors || []).length) throw new Error('acquisition errors present; production compilation blocked');

  const maps = snapshotMaps(acquisition);
  const rows = {
    tcgs: [], series: [], sets: [], setSourceMappings: [], printings: [], cardIdentities: [], cardSourceMappings: [], cardProvenance: [],
    variantSnapshots: [], variantReviews: [], variantStates: [], auditHolds: [], catalogueFlags: [], evidenceFlags: [], catalogueSnapshots: maps.catalogueRows,
  };
  const rejectedSets = [];
  let baseCards = 0;

  for (const entry of acquisition.sets || []) {
    const result = buildSetRows(entry, acquisition, maps, { verifiedAt, reviewReference });
    if (result.status !== 'verified') {
      rejectedSets.push({ setCode: result.nativeCode, conflicts: result.conflicts });
      continue;
    }
    baseCards += result.baseCards;
    mergeRows(rows, result.rows);
  }

  if (rejectedSets.length) {
    const error = new Error(`exact Japanese card crosswalk failed for ${rejectedSets.length} sets`);
    error.rejectedSets = rejectedSets;
    throw error;
  }
  if (!rows.sets.length || !rows.printings.length || !rows.cardIdentities.length) throw new Error('Japanese catalogue compiled no rows');

  for (const key of ['tcgs', 'series', 'sets', 'setSourceMappings', 'printings', 'cardIdentities', 'cardSourceMappings', 'cardProvenance', 'variantSnapshots', 'variantReviews', 'auditHolds', 'catalogueFlags', 'evidenceFlags', 'catalogueSnapshots']) {
    rows[key] = uniqueRows(rows[key]);
  }
  rows.variantStates = uniqueRows(rows.variantStates, 'cardIdentityId');

  const stateCounts = Object.fromEntries(STATES.map((state) => [state, rows.variantStates.filter((row) => row.state === state).length]));
  const audit = {
    totalBaseCardsIngested: baseCards,
    totalVariantsClassified: rows.variantStates.length,
    variantsByState: stateCounts,
    quarantinedSetIds: [],
    missingOrBrokenImages: rows.evidenceFlags.filter((row) => ['missing_thumbnail', 'broken_thumbnail'].includes(row.flagType)).length,
    unrecognisedVariantLabels: rows.evidenceFlags.filter((row) => row.flagType === 'unrecognised_variant_label').length,
  };

  return {
    format: JAPANESE_ARTIFACT_FORMAT,
    runId: acquisition.runId,
    generatedAt: new Date(verifiedAt).toISOString(),
    verifiedAt,
    reviewReference,
    productionWrites: false,
    counts: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.length])),
    audit,
    rows,
  };
}

export function validateJapaneseCatalogueArtifact(artifact) {
  if (artifact?.format !== JAPANESE_ARTIFACT_FORMAT) throw new Error(`unsupported Japanese artifact format: ${artifact?.format}`);
  if (!artifact?.runId || !artifact?.reviewReference) throw new Error('runId and reviewReference are required');
  if (!Array.isArray(artifact?.rows?.cardIdentities) || !artifact.rows.cardIdentities.length) throw new Error('Japanese identities are required');
  if (!Array.isArray(artifact?.rows?.variantStates) || artifact.rows.variantStates.length !== artifact.rows.cardIdentities.length) {
    throw new Error('every Japanese identity must have exactly one resolution state');
  }
  if ((artifact.audit?.quarantinedSetIds || []).length) throw new Error('quarantined sets block Japanese activation');
  for (const state of artifact.rows.variantStates) {
    if (!STATES.includes(state.state)) throw new Error(`unsupported state ${state.state}`);
  }
  return artifact;
}
