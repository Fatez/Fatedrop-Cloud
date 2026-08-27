import { assessExchangeConfidence } from '../trust/scoring.mjs';
import { getTrustProfileFromStore } from '../trust/store.mjs';

async function candidateUsersForOffers(store, offerIds = []) {
  const ids = [...new Set(offerIds.filter(Boolean))];
  const result = new Map();
  if (!ids.length) return result;

  if (typeof store?.read === 'function') {
    const state = await store.read();
    const binder = state.traderBinder || { binders: {}, items: {} };
    for (const id of ids) {
      const item = binder.items?.[id];
      const parent = item ? binder.binders?.[item.binderId] : null;
      if (parent?.userId) result.set(id, parent.userId);
    }
    return result;
  }

  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const { rows } = await pool.query(`SELECT bi.id,b.user_id
      FROM fatedrop_trade_binder_items bi
      JOIN fatedrop_trade_binders b ON b.id=bi.binder_id
      WHERE bi.id=ANY($1::text[])`, [ids]);
    for (const row of rows) result.set(row.id, row.user_id);
  }
  return result;
}

function methodFor(opportunity) {
  const methods = Array.isArray(opportunity?.commonTradeMethods) ? opportunity.commonTradeMethods : [];
  if (methods.includes('hub') || methods.includes('local')) return 'hub';
  return 'postal';
}

function publicTrust(profile) {
  if (!profile) return null;
  return Object.freeze({
    score: profile.score,
    level: profile.level,
    restricted: profile.restricted,
    effectiveTrades: profile.effectiveTrades,
    evidenceConfidence: profile.evidenceConfidence,
  });
}

export async function enrichFinderWithTrust(store, finderResult) {
  const opportunities = Array.isArray(finderResult?.opportunities) ? finderResult.opportunities : [];
  if (!opportunities.length) return finderResult;
  const candidateByOffer = await candidateUsersForOffers(store, opportunities.map((row) => row.candidateOfferId));
  const userIds = [...new Set([...candidateByOffer.values()])];
  const profiles = new Map();
  await Promise.all(userIds.map(async (userId) => {
    const profile = await getTrustProfileFromStore(store, { userId });
    if (profile) profiles.set(userId, profile);
  }));

  const enriched = opportunities.map((opportunity, originalIndex) => {
    const candidateUserId = candidateByOffer.get(opportunity.candidateOfferId) || null;
    const profile = candidateUserId ? profiles.get(candidateUserId) || null : null;
    const method = methodFor(opportunity);
    const hubAvailable = (opportunity.commonTradeMethods || []).some((value) => value === 'hub' || value === 'local');
    const exchangeConfidence = profile ? assessExchangeConfidence({
      trust: profile,
      proposedTradeValuePence: 0,
      verifiedTradeValuePence: profile.verifiedTradeValuePence,
      largestVerifiedTradeValuePence: profile.largestVerifiedTradeValuePence,
      method,
      hubAvailable,
    }) : null;
    return {
      ...opportunity,
      traderTrust: publicTrust(profile),
      exchangeConfidence,
      _trustScore: profile?.score ?? -1,
      _originalIndex: originalIndex,
    };
  });

  // Compatibility remains the primary ranking authority. FateTrust may only break
  // ties between already-valid opportunities with the same compatibility score.
  enriched.sort((a,b) => {
    if (Number(a.score) !== Number(b.score)) return a._originalIndex - b._originalIndex;
    if (a._trustScore !== b._trustScore) return b._trustScore - a._trustScore;
    return a._originalIndex - b._originalIndex;
  });

  const publicRows = enriched.map(({ _trustScore, _originalIndex, ...row }) => Object.freeze(row));
  return Object.freeze({ ...finderResult, opportunities: Object.freeze(publicRows) });
}
