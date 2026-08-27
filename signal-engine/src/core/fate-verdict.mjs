function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0 ? value : null;
}

function cleanKey(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

const TRUSTED_UK_RRP_KINDS = new Set(["official", "component_reference", "pack_reference"]);
const TRUSTED_SOURCE_MARKET_REFERENCE_KINDS = new Set(["source_market_msrp", "source_market_component_reference"]);
const TRUSTED_COMPARISON_REFERENCE_KINDS = new Set([
  ...TRUSTED_UK_RRP_KINDS,
  ...TRUSTED_SOURCE_MARKET_REFERENCE_KINDS,
]);

export const FateComparisonMode = Object.freeze({
  LIKE_FOR_LIKE: "like_for_like",
  NORMALIZED_OWN_RRP: "normalized_own_rrp",
});

function normalizedReleaseTitle(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namedReleaseFamilyKey(title = "") {
  let text = normalizedReleaseTitle(title)
    .replace(/\b(?:pokemon|tcg|trading card game|trading cards|cards)\b/g, " ")
    .replace(/\bscarlet\s+(?:and\s+)?violet(?:\s+\d{1,2})?\b/g, " ")
    .replace(/\bsword\s+(?:and\s+)?shield(?:\s+\d{1,2})?\b/g, " ")
    .replace(/\bsun\s+(?:and\s+)?moon(?:\s+\d{1,2})?\b/g, " ")
    .replace(/\bmega\s+evolution(?:\s+\d{1,2})?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const configurationMarker = /\b(?:elite trainer box|etb|half booster box|booster display(?: box)?|booster box|booster bundle|sleeved booster(?: pack)?|booster pack|premium checklane blister|checklane blister|triple blister|\d{1,3}\s+pack(?:s)?\s+(?:bundle|blister)|\d{1,3}\s+booster packs?|build\s+(?:and\s+)?battle|collection box|collection|tin|deck|sealed case|case)\b/;
  const marker = text.match(configurationMarker);
  if (marker?.index != null && marker.index > 0) text = text.slice(0, marker.index);

  text = text
    .replace(/\b(?:sealed|standard|english|uk|united kingdom)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = text.split(" ").filter(Boolean);
  return tokens.length >= 2 ? tokens.join(" ") : null;
}

function sameVerifiedMixedReferenceRelease(leftGroup, rightGroup) {
  const leftReference = rrpEvidence(leftGroup);
  const rightReference = rrpEvidence(rightGroup);
  if (!leftReference || !rightReference) return false;

  const leftKind = cleanKey(leftReference.kind);
  const rightKind = cleanKey(rightReference.kind);
  if (!TRUSTED_UK_RRP_KINDS.has(leftKind) || !TRUSTED_UK_RRP_KINDS.has(rightKind)) return false;

  // Keep the existing family fallback for legacy unit/family semantics only.
  // Normalized own-RRP eligibility is decided separately and never rewrites
  // canonical identity or value-family keys.
  if (![leftKind, rightKind].some((kind) => kind === "component_reference" || kind === "pack_reference")) return false;

  const leftRelease = namedReleaseFamilyKey(leftGroup?.title);
  const rightRelease = namedReleaseFamilyKey(rightGroup?.title);
  return Boolean(leftRelease && rightRelease && leftRelease === rightRelease);
}

export const FateVerdictReason = Object.freeze({
  IDENTITY_UNRESOLVED: "IDENTITY_UNRESOLVED",
  CONFIGURATION_NOT_COMPARABLE: "CONFIGURATION_NOT_COMPARABLE",
  NO_VERIFIED_REFERENCE: "NO_VERIFIED_REFERENCE",
  NO_QUALIFYING_LIVE_OFFERS: "NO_QUALIFYING_LIVE_OFFERS",
  TIED_EVIDENCE: "TIED_EVIDENCE",
  WINNER_RRP_PERCENT: "WINNER_RRP_PERCENT",
  WINNER_UNIT_TRUE_PRICE: "WINNER_UNIT_TRUE_PRICE",
});

export function bestOffer(group) {
  const offers = (Array.isArray(group?.offers) ? group.offers : [])
    .filter((offer) => finite(offer?.priceGbp) && offer.priceGbp > 0);

  offers.sort((a, b) => {
    // Fate Verdict's first commercial comparison remains item price. Delivery is
    // a separate True Price signal and is only used as a tie-break when known.
    if (a.priceGbp !== b.priceGbp) return a.priceGbp - b.priceGbp;
    if (Boolean(a.deliveryKnown) !== Boolean(b.deliveryKnown)) return a.deliveryKnown ? -1 : 1;
    if (a.deliveryKnown && b.deliveryKnown) {
      const gap = (finite(a.totalDeliveredGbp) ? a.totalDeliveredGbp : Infinity)
        - (finite(b.totalDeliveredGbp) ? b.totalDeliveredGbp : Infinity);
      if (gap !== 0) return gap;
    }
    const aSeen = Date.parse(a.lastCheckedAt || "") || 0;
    const bSeen = Date.parse(b.lastCheckedAt || "") || 0;
    return bSeen - aSeen || String(a.retailerName || "").localeCompare(String(b.retailerName || ""));
  });
  return offers[0] || null;
}

export function rrpEvidence(group) {
  const source = typeof group?.rrpSource === "string" && group.rrpSource.trim() ? group.rrpSource : null;
  const kind = typeof group?.rrpKind === "string" && group.rrpKind.trim() ? group.rrpKind : null;
  if (!source) return null;

  const directRrpGbp = positive(group?.rrpGbp);
  const unitRrpGbp = positive(group?.unitRrpGbp);
  const unitCount = positive(group?.unitCount);
  const scaledRrpGbp = unitRrpGbp !== null && unitCount !== null ? unitRrpGbp * unitCount : null;

  // A direct RRP and its scaled component reference must agree. If they do not,
  // fail closed rather than choosing whichever value is more convenient.
  if (directRrpGbp !== null && scaledRrpGbp !== null && Math.abs(directRrpGbp - scaledRrpGbp) > 0.005) {
    return null;
  }

  const rrpGbp = directRrpGbp ?? scaledRrpGbp;
  if (rrpGbp === null) return null;

  return {
    rrpGbp,
    directRrpGbp,
    unitRrpGbp,
    unitCount,
    unitKind: cleanKey(group?.unitKind),
    source,
    kind,
    observedAt: typeof group?.rrpObservedAt === "string" ? group.rrpObservedAt : null,
    basis: typeof group?.rrpReferenceBasis === "string" ? group.rrpReferenceBasis : null,
    scaledFromUnit: directRrpGbp === null && scaledRrpGbp !== null,
  };
}

export function effectiveRrp(group) {
  return rrpEvidence(group)?.rrpGbp ?? null;
}

export function hasResolvedProductIdentity(group) {
  const identity = cleanKey(group?.identityKey);
  const canonicalProductId = cleanKey(group?.canonicalProductId || group?.id);
  const configurationId = cleanKey(group?.configurationId || group?.id);
  return Boolean(identity && canonicalProductId && configurationId);
}

// UK RRP/reference eligibility remains deliberately narrow. This is the gate used
// for cross-family normalized comparisons where every product must be judged
// against its own trustworthy UK baseline.
export function trustedRrpEvidence(group) {
  if (!hasResolvedProductIdentity(group)) return null;
  const reference = rrpEvidence(group);
  if (!reference || !TRUSTED_UK_RRP_KINDS.has(cleanKey(reference.kind))) return null;
  return reference;
}

// Same-family source-market products (for example a Japanese pack and its 30-pack
// box) may still use their verified native MSRP reference, converted to GBP by the
// authority layer. This does not make that reference a UK RRP and does not make it
// eligible for arbitrary cross-family UK value ranking.
function trustedComparisonReferenceEvidence(group) {
  if (!hasResolvedProductIdentity(group)) return null;
  const reference = rrpEvidence(group);
  if (!reference || !TRUSTED_COMPARISON_REFERENCE_KINDS.has(cleanKey(reference.kind))) return null;
  return reference;
}

function hasRrpReferenceClaim(group) {
  const source = typeof group?.rrpSource === "string" && group.rrpSource.trim();
  return Boolean(source || positive(group?.rrpGbp) !== null || positive(group?.unitRrpGbp) !== null);
}

function sameExactProductIdentity(leftGroup, rightGroup) {
  const leftIdentity = cleanKey(leftGroup?.identityKey);
  const rightIdentity = cleanKey(rightGroup?.identityKey);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

export function sameComparableFamily(leftGroup, rightGroup) {
  if (sameExactProductIdentity(leftGroup, rightGroup)) return true;

  // Different configurations (1-pack / 4-pack / 10-pack) intentionally have
  // distinct identity keys. This helper still answers only the legacy family
  // question; it no longer gates normalized % vs each product's own verified RRP.
  const leftFamily = cleanKey(leftGroup?.valueFamilyKey);
  const rightFamily = cleanKey(rightGroup?.valueFamilyKey);
  if (leftFamily && rightFamily && leftFamily === rightFamily) return true;
  return sameVerifiedMixedReferenceRelease(leftGroup, rightGroup);
}

function rrpComparisonMode(leftGroup, rightGroup) {
  if (!trustedComparisonReferenceEvidence(leftGroup) || !trustedComparisonReferenceEvidence(rightGroup)) return null;
  if (sameExactProductIdentity(leftGroup, rightGroup)) return FateComparisonMode.LIKE_FOR_LIKE;
  if (sameComparableFamily(leftGroup, rightGroup)) return FateComparisonMode.NORMALIZED_OWN_RRP;
  if (trustedRrpEvidence(leftGroup) && trustedRrpEvidence(rightGroup)) return FateComparisonMode.NORMALIZED_OWN_RRP;
  return null;
}

export function valuePosition(group) {
  const offer = bestOffer(group);
  if (!offer) return null;

  const itemPrice = finite(offer.priceGbp) && offer.priceGbp > 0 ? offer.priceGbp : null;
  const truePrice = offer.deliveryKnown && finite(offer.totalDeliveredGbp) && offer.totalDeliveredGbp > 0
    ? offer.totalDeliveredGbp
    : null;
  const reference = rrpEvidence(group);
  const trustedReference = trustedComparisonReferenceEvidence(group);
  const rrpGbp = reference?.rrpGbp ?? null;
  const rrpPercent = itemPrice !== null && trustedReference
    ? ((itemPrice - trustedReference.rrpGbp) / trustedReference.rrpGbp) * 100
    : null;
  const unitCount = positive(group?.unitCount);
  const unitCost = truePrice !== null && unitCount !== null ? truePrice / unitCount : null;

  return {
    groupId: group.id,
    canonicalProductId: group.canonicalProductId || group.id || null,
    configurationId: group.configurationId || group.id || null,
    title: group.title,
    identityKey: cleanKey(group?.identityKey),
    valueFamilyKey: cleanKey(group?.valueFamilyKey),
    offerId: offer.id,
    retailerId: offer.retailerId,
    retailerName: offer.retailerName,
    itemPrice,
    truePrice,
    checkoutCost: truePrice,
    rrpGbp,
    rrpPercent,
    referenceEligible: Boolean(trustedReference),
    unitCount,
    unitKind: cleanKey(group?.unitKind),
    unitCost,
    deliveryKnown: Boolean(offer.deliveryKnown),
    provisional: !offer.deliveryKnown,
    reference,
    truePriceEvidence: {
      itemPriceGbp: itemPrice,
      deliveryGbp: offer.deliveryKnown && finite(offer.shippingGbp) ? offer.shippingGbp : null,
      totalGbp: truePrice,
      deliveryKnown: Boolean(offer.deliveryKnown),
      retailerName: offer.retailerName || null,
      observedAt: offer.lastCheckedAt || null,
      stockStatus: offer.stockStatus || null,
    },
  };
}

function noWinner(left, right, reasonCode, reason, comparisonMode = null) {
  return { left, right, winnerId: null, basis: null, gap: null, reasonCode, reason, comparisonMode };
}

function rrpWinnerReason(winner, comparisonMode) {
  if (comparisonMode === FateComparisonMode.LIKE_FOR_LIKE) {
    return `${winner.title} has the better value position versus the verified RRP/reference baseline in a like-for-like identity comparison.`;
  }
  return `${winner.title} is closer to its own verified RRP/reference baseline. This is a normalized % vs own RRP/reference comparison, not a like-for-like product comparison.`;
}

export function compareGroups(leftGroup, rightGroup) {
  if (!leftGroup || !rightGroup) {
    return noWinner(
      leftGroup ? valuePosition(leftGroup) : null,
      rightGroup ? valuePosition(rightGroup) : null,
      FateVerdictReason.IDENTITY_UNRESOLVED,
      "FateDrop could not resolve both selected canonical product configurations.",
    );
  }

  const left = valuePosition(leftGroup);
  const right = valuePosition(rightGroup);
  if (!left || !right) {
    return noWinner(left, right, FateVerdictReason.NO_QUALIFYING_LIVE_OFFERS, "FateDrop needs a qualifying live commercial offer for both selected configurations.");
  }
  if (left.groupId === right.groupId) {
    return noWinner(left, right, FateVerdictReason.CONFIGURATION_NOT_COMPARABLE, "Choose two different product configurations to run a Fate Verdict.");
  }
  if (!hasResolvedProductIdentity(leftGroup) || !hasResolvedProductIdentity(rightGroup)) {
    return noWinner(left, right, FateVerdictReason.IDENTITY_UNRESOLVED, "FateDrop will not compare a product until both canonical identities are resolved safely.");
  }

  const comparisonMode = rrpComparisonMode(leftGroup, rightGroup);
  const leftHasTrustedRrp = left.rrpPercent !== null;
  const rightHasTrustedRrp = right.rrpPercent !== null;

  if (leftHasTrustedRrp || rightHasTrustedRrp) {
    if (!leftHasTrustedRrp || !rightHasTrustedRrp || !comparisonMode) {
      return noWinner(left, right, FateVerdictReason.NO_VERIFIED_REFERENCE, "FateDrop needs trustworthy verified RRP/reference evidence in a compatible comparison scope before declaring a reference-based winner.");
    }

    const gap = Math.abs(left.rrpPercent - right.rrpPercent);
    if (gap > 1e-9) {
      const winner = left.rrpPercent < right.rrpPercent ? left : right;
      return {
        left,
        right,
        winnerId: winner.groupId,
        basis: "rrp_percent",
        gap,
        reasonCode: FateVerdictReason.WINNER_RRP_PERCENT,
        reason: rrpWinnerReason(winner, comparisonMode),
        comparisonMode,
      };
    }

    // Absolute checkout cost is only a valid tie-break for the same exact product
    // identity. It must never make a cheaper pack beat a larger unlike product
    // when both are equally far from their own verified baselines.
    if (comparisonMode === FateComparisonMode.LIKE_FOR_LIKE
      && left.truePrice !== null
      && right.truePrice !== null
      && Math.abs(left.truePrice - right.truePrice) > 1e-9) {
      const winner = left.truePrice < right.truePrice ? left : right;
      return {
        left,
        right,
        winnerId: winner.groupId,
        basis: "rrp_percent",
        gap: 0,
        reasonCode: FateVerdictReason.WINNER_RRP_PERCENT,
        reason: `${winner.title} matches the RRP/reference value position and has the lower known True Price in a like-for-like identity comparison.`,
        comparisonMode,
      };
    }

    const tiedReason = comparisonMode === FateComparisonMode.NORMALIZED_OWN_RRP
      ? "These unlike product identities are tied on normalized % vs their own verified RRP/reference baselines; absolute checkout price is not a safe cross-product tie-break."
      : "These like-for-like candidates currently have the same verified RRP/reference value position and no trustworthy known True Price tie-break.";
    return noWinner(left, right, FateVerdictReason.TIED_EVIDENCE, tiedReason, comparisonMode);
  }

  // A claimed-but-conflicting or otherwise untrusted reference cannot silently
  // fall through into another winner path. Unknown stays unknown.
  if (hasRrpReferenceClaim(leftGroup) || hasRrpReferenceClaim(rightGroup)) {
    return noWinner(left, right, FateVerdictReason.NO_VERIFIED_REFERENCE, "FateDrop found RRP/reference evidence that is not eligible for this comparison scope, so it will not declare a winner.");
  }

  if (!sameComparableFamily(leftGroup, rightGroup)) {
    return noWinner(left, right, FateVerdictReason.CONFIGURATION_NOT_COMPARABLE, "FateDrop could not verify a shared canonical value family and neither product has its own trustworthy verified UK RRP/reference for normalized cross-family comparison.");
  }

  const safeUnitComparison = left.unitCost !== null
    && right.unitCost !== null
    && left.unitKind
    && left.unitKind === right.unitKind;
  if (safeUnitComparison) {
    const gap = Math.abs(left.unitCost - right.unitCost);
    if (gap <= 1e-9) {
      return noWinner(left, right, FateVerdictReason.TIED_EVIDENCE, "These configurations currently have the same known True Price per comparable unit.");
    }
    const winner = left.unitCost < right.unitCost ? left : right;
    return {
      left,
      right,
      winnerId: winner.groupId,
      basis: "unit_true_price",
      gap,
      reasonCode: FateVerdictReason.WINNER_UNIT_TRUE_PRICE,
      reason: `${winner.title} has the lower known True Price per ${winner.unitKind === "booster_pack" ? "pack" : "unit"}.`,
      comparisonMode: FateComparisonMode.LIKE_FOR_LIKE,
    };
  }

  return noWinner(left, right, FateVerdictReason.NO_VERIFIED_REFERENCE, "FateDrop needs comparable verified RRP/reference or unit evidence before declaring a winner.");
}

function sortRrpPositions(positions, { allowTruePriceTieBreak = false } = {}) {
  return [...positions].sort((a, b) => {
    const gap = a.rrpPercent - b.rrpPercent;
    if (Math.abs(gap) > 1e-9) return gap;
    if (allowTruePriceTieBreak && a.truePrice !== null && b.truePrice !== null && a.truePrice !== b.truePrice) return a.truePrice - b.truePrice;
    if (a.deliveryKnown !== b.deliveryKnown) return a.deliveryKnown ? -1 : 1;
    return 0;
  });
}

function rrpLeadersTied(ranking, { allowTruePriceTieBreak = false } = {}) {
  const winner = ranking[0];
  const runnerUp = ranking[1];
  if (!winner || !runnerUp) return false;
  if (Math.abs(winner.rrpPercent - runnerUp.rrpPercent) > 1e-9) return false;
  if (allowTruePriceTieBreak
    && winner.truePrice !== null
    && runnerUp.truePrice !== null
    && Math.abs(winner.truePrice - runnerUp.truePrice) > 1e-9) return false;
  return true;
}

function rankingComparisonMode(entries) {
  if (entries.length < 2) return null;
  const first = entries[0].group;
  return entries.every((entry) => sameExactProductIdentity(first, entry.group))
    ? FateComparisonMode.LIKE_FOR_LIKE
    : FateComparisonMode.NORMALIZED_OWN_RRP;
}

export function rankGroups(groups) {
  const source = Array.isArray(groups) ? groups : [];
  const positioned = source.map((group) => ({ group, position: valuePosition(group) })).filter((entry) => entry.position);
  const positions = positioned.map((entry) => entry.position);
  const provisional = positions.some((item) => item.provisional);

  if (!positions.length) {
    return {
      winnerId: null,
      basis: null,
      reasonCode: FateVerdictReason.NO_QUALIFYING_LIVE_OFFERS,
      reason: "No qualifying live commercial offers are available to rank.",
      comparisonMode: null,
      provisional,
      ranking: [],
    };
  }

  const allSameFamily = positioned.length <= 1
    || positioned.every((entry) => sameComparableFamily(positioned[0].group, entry.group));
  const comparisonReferencedEntries = positioned.filter((entry) => entry.position.rrpPercent !== null);
  const referencedEntries = allSameFamily
    ? comparisonReferencedEntries
    : comparisonReferencedEntries.filter((entry) => Boolean(trustedRrpEvidence(entry.group)));
  const unreferencedEntries = positioned.filter((entry) => !referencedEntries.includes(entry));

  // Same-family products may rank against any trusted reference appropriate to
  // that canonical family, including a verified source-market MSRP family. Mixed
  // families may normalize only against trustworthy UK RRP/reference evidence.
  // In both cases identities stay distinct and comparison mode remains explicit.
  if (referencedEntries.length >= 2 || (referencedEntries.length === 1 && allSameFamily)) {
    const comparisonMode = rankingComparisonMode(referencedEntries);
    const allowTruePriceTieBreak = comparisonMode === FateComparisonMode.LIKE_FOR_LIKE;
    const referencedRanking = sortRrpPositions(
      referencedEntries.map((entry) => entry.position),
      { allowTruePriceTieBreak },
    );
    const winner = referencedRanking[0];
    const tied = rrpLeadersTied(referencedRanking, { allowTruePriceTieBreak });
    const unresolvedCount = unreferencedEntries.length;
    const ranking = [...referencedRanking, ...unreferencedEntries.map((entry) => entry.position)];
    const exclusion = unresolvedCount
      ? ` ${unresolvedCount} candidate${unresolvedCount === 1 ? " remains" : "s remain"} outside the value ranking because its identity/reference evidence is unavailable or not eligible for this comparison scope.`
      : "";

    let reason;
    if (tied) {
      reason = comparisonMode === FateComparisonMode.NORMALIZED_OWN_RRP
        ? `The leading unlike products are tied on normalized % vs their own verified RRP/reference baselines; absolute checkout price is not used as a cross-product tie-break.${exclusion}`
        : `The leading like-for-like candidates are tied on verified RRP/reference value position and available True Price evidence.${exclusion}`;
    } else if (comparisonMode === FateComparisonMode.NORMALIZED_OWN_RRP) {
      reason = `${winner.title} has the strongest normalized % vs own verified RRP/reference position. Unlike product identities remain distinct and are not being treated as like-for-like.${exclusion}`;
    } else if (comparisonMode === FateComparisonMode.LIKE_FOR_LIKE) {
      reason = `${winner.title} has the strongest verified RRP/reference value position in a like-for-like identity comparison.${exclusion}`;
    } else {
      reason = `${winner.title} is the only reference-backed candidate currently eligible for this value-family ranking.${exclusion}`;
    }

    return {
      winnerId: tied ? null : winner.groupId,
      basis: "rrp_percent",
      reasonCode: tied ? FateVerdictReason.TIED_EVIDENCE : FateVerdictReason.WINNER_RRP_PERCENT,
      reason,
      comparisonMode,
      provisional,
      ranking,
    };
  }

  if (!allSameFamily) {
    return {
      winnerId: null,
      basis: null,
      reasonCode: FateVerdictReason.CONFIGURATION_NOT_COMPARABLE,
      reason: "FateDrop found mixed product value families without at least two identity-safe products carrying trustworthy UK own-RRP/reference evidence, so it will not declare a cross-product winner.",
      comparisonMode: null,
      provisional,
      ranking: positions,
    };
  }

  if (positioned.some((entry) => !hasResolvedProductIdentity(entry.group))) {
    return {
      winnerId: null,
      basis: null,
      reasonCode: FateVerdictReason.IDENTITY_UNRESOLVED,
      reason: "FateDrop will not rank unresolved canonical product identities.",
      comparisonMode: null,
      provisional,
      ranking: positions,
    };
  }

  if (positioned.some((entry) => hasRrpReferenceClaim(entry.group))) {
    return {
      winnerId: null,
      basis: null,
      reasonCode: FateVerdictReason.NO_VERIFIED_REFERENCE,
      reason: "FateDrop found RRP/reference evidence that is conflicting or otherwise not eligible for this value ranking.",
      comparisonMode: null,
      provisional,
      ranking: positions,
    };
  }

  const unitKinds = new Set(positions.map((item) => item.unitKind).filter(Boolean));
  const comparable = positions.every((item) => item.unitCost !== null && item.unitKind) && unitKinds.size === 1;
  if (comparable) {
    const ranking = [...positions].sort((a, b) => a.unitCost - b.unitCost);
    const winner = ranking[0];
    const tied = ranking[1] && Math.abs(winner.unitCost - ranking[1].unitCost) <= 1e-9;
    return {
      winnerId: tied ? null : winner.groupId,
      basis: "unit_true_price",
      reasonCode: tied ? FateVerdictReason.TIED_EVIDENCE : FateVerdictReason.WINNER_UNIT_TRUE_PRICE,
      reason: tied
        ? "The leading candidates are tied on known True Price per comparable unit."
        : `${winner.title} has the lowest known True Price per ${winner.unitKind === "booster_pack" ? "pack" : "unit"} across the comparable searched items.`,
      comparisonMode: FateComparisonMode.LIKE_FOR_LIKE,
      provisional,
      ranking,
    };
  }

  return {
    winnerId: null,
    basis: null,
    reasonCode: FateVerdictReason.NO_VERIFIED_REFERENCE,
    reason: "FateDrop cannot declare a trustworthy best deal until the searched items have comparable RRP/reference or unit evidence.",
    comparisonMode: null,
    provisional,
    ranking: positions,
  };
}
