function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function bestOffer(group) {
  const offers = Array.isArray(group?.offers) ? [...group.offers] : [];
  offers.sort((a, b) => {
    if (Boolean(a.deliveryKnown) !== Boolean(b.deliveryKnown)) return a.deliveryKnown ? -1 : 1;
    const aCost = finite(a.totalDeliveredGbp) ? a.totalDeliveredGbp : finite(a.priceGbp) ? a.priceGbp : Infinity;
    const bCost = finite(b.totalDeliveredGbp) ? b.totalDeliveredGbp : finite(b.priceGbp) ? b.priceGbp : Infinity;
    return aCost - bCost;
  });
  return offers[0] || null;
}

export function effectiveRrp(group) {
  if (finite(group?.rrpGbp) && group.rrpGbp > 0) return group.rrpGbp;
  if (finite(group?.unitRrpGbp) && group.unitRrpGbp > 0 && finite(group?.unitCount) && group.unitCount > 0) {
    return group.unitRrpGbp * group.unitCount;
  }
  return null;
}

export function valuePosition(group) {
  const offer = bestOffer(group);
  if (!offer) return null;

  const itemPrice = finite(offer.priceGbp) ? offer.priceGbp : null;
  const truePrice = offer.deliveryKnown && finite(offer.totalDeliveredGbp) ? offer.totalDeliveredGbp : null;
  const checkoutCost = truePrice ?? itemPrice;
  const rrpGbp = effectiveRrp(group);
  const rrpPercent = itemPrice !== null && rrpGbp !== null
    ? ((itemPrice - rrpGbp) / rrpGbp) * 100
    : null;
  const unitCost = checkoutCost !== null && finite(group?.unitCount) && group.unitCount > 0
    ? checkoutCost / group.unitCount
    : null;

  return {
    groupId: group.id,
    title: group.title,
    offerId: offer.id,
    retailerId: offer.retailerId,
    retailerName: offer.retailerName,
    itemPrice,
    truePrice,
    checkoutCost,
    rrpGbp,
    rrpPercent,
    unitCount: finite(group?.unitCount) ? group.unitCount : null,
    unitKind: group?.unitKind || null,
    unitCost,
    deliveryKnown: Boolean(offer.deliveryKnown),
    provisional: !offer.deliveryKnown,
  };
}

export function comparePositions(left, right) {
  if (!left || !right || left.groupId === right.groupId) {
    return { winnerId: null, basis: null, gap: null, reason: "Choose two different comparable items." };
  }

  if (left.rrpPercent !== null && right.rrpPercent !== null) {
    const winner = left.rrpPercent <= right.rrpPercent ? left : right;
    const loser = winner === left ? right : left;
    return {
      winnerId: winner.groupId,
      basis: "rrp_percent",
      gap: Math.abs(winner.rrpPercent - loser.rrpPercent),
      reason: `${winner.title} has the better value position versus its verified RRP/reference baseline based on item price.`,
    };
  }

  if (left.unitCost !== null && right.unitCost !== null && left.unitKind && left.unitKind === right.unitKind) {
    const winner = left.unitCost <= right.unitCost ? left : right;
    const loser = winner === left ? right : left;
    return {
      winnerId: winner.groupId,
      basis: "unit_true_price",
      gap: Math.abs(winner.unitCost - loser.unitCost),
      reason: `${winner.title} has the lower ${winner.deliveryKnown && loser.deliveryKnown ? "delivered " : ""}cost per ${winner.unitKind === "booster_pack" ? "pack" : "unit"}.`,
    };
  }

  return {
    winnerId: null,
    basis: null,
    gap: null,
    reason: "FateDrop needs comparable verified RRP/reference or unit evidence before declaring a winner.",
  };
}

export function compareGroups(leftGroup, rightGroup) {
  const left = valuePosition(leftGroup);
  const right = valuePosition(rightGroup);
  return { left, right, ...comparePositions(left, right) };
}

export function rankGroups(groups) {
  const positions = (Array.isArray(groups) ? groups : []).map(valuePosition).filter(Boolean);
  const withRrp = positions.filter((item) => item.rrpPercent !== null);

  if (withRrp.length) {
    const ranking = [...withRrp].sort((a, b) => a.rrpPercent - b.rrpPercent || (a.checkoutCost ?? Infinity) - (b.checkoutCost ?? Infinity));
    const winner = ranking[0];
    return {
      winnerId: winner.groupId,
      basis: "rrp_percent",
      reason: `${winner.title} has the strongest value position versus its verified RRP/reference baseline across the searched items.`,
      provisional: ranking.some((item) => item.provisional),
      ranking,
    };
  }

  const unitKinds = new Set(positions.map((item) => item.unitKind).filter(Boolean));
  if (unitKinds.size === 1) {
    const comparable = positions.filter((item) => item.unitCost !== null);
    if (comparable.length) {
      const ranking = [...comparable].sort((a, b) => a.unitCost - b.unitCost);
      const winner = ranking[0];
      return {
        winnerId: winner.groupId,
        basis: "unit_true_price",
        reason: `${winner.title} has the lowest observed cost per ${winner.unitKind === "booster_pack" ? "pack" : "unit"} across the searched items.`,
        provisional: ranking.some((item) => item.provisional),
        ranking,
      };
    }
  }

  return {
    winnerId: null,
    basis: null,
    reason: "FateDrop cannot declare a trustworthy best deal until the searched items have comparable RRP/reference or unit evidence.",
    provisional: positions.some((item) => item.provisional),
    ranking: positions,
  };
}
