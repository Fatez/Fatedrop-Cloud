function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0 ? value : null;
}

function cleanKey(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
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

export function sameComparableFamily(leftGroup, rightGroup) {
  const leftIdentity = cleanKey(leftGroup?.identityKey);
  const rightIdentity = cleanKey(rightGroup?.identityKey);
  if (leftIdentity && rightIdentity && leftIdentity === rightIdentity) return true;

  // Different configurations (1-pack / 4-pack / 10-pack) intentionally have
  // distinct identity keys. They are comparable only when Cloud resolved them
  // to the same verified value-family reference.
  const leftFamily = cleanKey(leftGroup?.valueFamilyKey);
  const rightFamily = cleanKey(rightGroup?.valueFamilyKey);
  return Boolean(leftFamily && rightFamily && leftFamily === rightFamily);
}

export function valuePosition(group) {
  const offer = bestOffer(group);
  if (!offer) return null;

  const itemPrice = finite(offer.priceGbp) && offer.priceGbp > 0 ? offer.priceGbp : null;
  const truePrice = offer.deliveryKnown && finite(offer.totalDeliveredGbp) && offer.totalDeliveredGbp > 0
    ? offer.totalDeliveredGbp
    : null;
  const reference = rrpEvidence(group);
  const rrpGbp = reference?.rrpGbp ?? null;
  const rrpPercent = itemPrice !== null && rrpGbp !== null
    ? ((itemPrice - rrpGbp) / rrpGbp) * 100
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

function noWinner(left, right, reasonCode, reason) {
  return { left, right, winnerId: null, basis: null, gap: null, reasonCode, reason };
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
  if (!sameComparableFamily(leftGroup, rightGroup)) {
    return noWinner(left, right, FateVerdictReason.CONFIGURATION_NOT_COMPARABLE, "FateDrop could not verify that these configurations share the same canonical value family.");
  }

  const leftHasRrp = left.rrpPercent !== null;
  const rightHasRrp = right.rrpPercent !== null;
  if (leftHasRrp !== rightHasRrp) {
    return noWinner(left, right, FateVerdictReason.NO_VERIFIED_REFERENCE, "FateDrop needs verified RRP/reference evidence for both configurations before declaring an RRP-based winner.");
  }

  if (leftHasRrp && rightHasRrp) {
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
        reason: `${winner.title} has the better value position versus its verified RRP/reference baseline based on item price.`,
      };
    }

    if (left.truePrice !== null && right.truePrice !== null && Math.abs(left.truePrice - right.truePrice) > 1e-9) {
      const winner = left.truePrice < right.truePrice ? left : right;
      return {
        left,
        right,
        winnerId: winner.groupId,
        basis: "rrp_percent",
        gap: 0,
        reasonCode: FateVerdictReason.WINNER_RRP_PERCENT,
        reason: `${winner.title} matches the RRP value position and has the lower known True Price.`,
      };
    }

    return noWinner(left, right, FateVerdictReason.TIED_EVIDENCE, "These configurations currently have the same verified RRP value position and no trustworthy known True Price tie-break.");
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
    };
  }

  return noWinner(left, right, FateVerdictReason.NO_VERIFIED_REFERENCE, "FateDrop needs comparable verified RRP/reference or unit evidence before declaring a winner.");
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
      provisional,
      ranking: [],
    };
  }

  if (positioned.length > 1 && positioned.some((entry) => !sameComparableFamily(positioned[0].group, entry.group))) {
    return {
      winnerId: null,
      basis: null,
      reasonCode: FateVerdictReason.CONFIGURATION_NOT_COMPARABLE,
      reason: "FateDrop found mixed product value families, so it will not declare one cross-product winner.",
      provisional,
      ranking: positions,
    };
  }

  const allHaveRrp = positions.every((item) => item.rrpPercent !== null);
  const noneHaveRrp = positions.every((item) => item.rrpPercent === null);
  if (!allHaveRrp && !noneHaveRrp) {
    return {
      winnerId: null,
      basis: null,
      reasonCode: FateVerdictReason.NO_VERIFIED_REFERENCE,
      reason: "FateDrop needs verified RRP/reference evidence for every comparable candidate before declaring a winner.",
      provisional,
      ranking: positions,
    };
  }

  if (allHaveRrp) {
    const ranking = [...positions].sort((a, b) => {
      const gap = a.rrpPercent - b.rrpPercent;
      if (Math.abs(gap) > 1e-9) return gap;
      if (a.truePrice !== null && b.truePrice !== null && a.truePrice !== b.truePrice) return a.truePrice - b.truePrice;
      if (a.deliveryKnown !== b.deliveryKnown) return a.deliveryKnown ? -1 : 1;
      return 0;
    });
    const winner = ranking[0];
    const runnerUp = ranking[1];
    const tied = Boolean(runnerUp
      && Math.abs(winner.rrpPercent - runnerUp.rrpPercent) <= 1e-9
      && (winner.truePrice === null || runnerUp.truePrice === null || Math.abs(winner.truePrice - runnerUp.truePrice) <= 1e-9));

    return {
      winnerId: tied ? null : winner.groupId,
      basis: "rrp_percent",
      reasonCode: tied ? FateVerdictReason.TIED_EVIDENCE : FateVerdictReason.WINNER_RRP_PERCENT,
      reason: tied
        ? "The leading candidates are tied on verified RRP value position and available True Price evidence."
        : `${winner.title} has the strongest value position versus its verified RRP/reference baseline across the comparable searched items.`,
      provisional,
      ranking,
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
      provisional,
      ranking,
    };
  }

  return {
    winnerId: null,
    basis: null,
    reasonCode: FateVerdictReason.NO_VERIFIED_REFERENCE,
    reason: "FateDrop cannot declare a trustworthy best deal until the searched items have comparable RRP/reference or unit evidence.",
    provisional,
    ranking: positions,
  };
}
