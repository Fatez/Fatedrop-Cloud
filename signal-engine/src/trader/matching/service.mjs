import { evaluateTradeOpportunity, rankTradeOpportunities } from './compatibility.mjs';

function safeLimit(value, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function isoStamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return new Date(numeric).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function constraintsFromRow(row = {}) {
  return {
    copyState: row.copy_state ?? row.copyState ?? 'any',
    minimumConditionCode: row.minimum_condition_code ?? row.minimumConditionCode ?? null,
    minimumGrade: row.minimum_grade == null ? (row.minimumGrade ?? null) : Number(row.minimum_grade),
    maximumGrade: row.maximum_grade == null ? (row.maximumGrade ?? null) : Number(row.maximum_grade),
    acceptedGradingCompanies: Array.isArray(row.accepted_grading_companies)
      ? row.accepted_grading_companies
      : (Array.isArray(row.acceptedGradingCompanies) ? row.acceptedGradingCompanies : []),
    localTradeAllowed: row.local_trade_allowed == null ? (row.localTradeAllowed ?? true) : Boolean(row.local_trade_allowed),
    postalTradeAllowed: row.postal_trade_allowed == null ? (row.postalTradeAllowed ?? true) : Boolean(row.postal_trade_allowed),
  };
}

function wantFromRow(row, constraints = null) {
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    fateCardId: row.card_identity_id ?? row.cardIdentityId ?? row.fateCardId,
    quantity: Number(row.quantity ?? 1),
    active: row.active !== false,
    createdAt: isoStamp(row.created_at ?? row.createdAt),
    updatedAt: isoStamp(row.updated_at ?? row.updatedAt),
    constraints: constraints || constraintsFromRow(row),
  };
}

function offerFromParts({ binderItem, binder, collectionItem, grading = null, card = null }) {
  return {
    id: binderItem.id,
    binderItemId: binderItem.id,
    userId: binder.userId,
    fateCardId: collectionItem.fateCardId,
    tradeQuantity: Number(collectionItem.tradeQuantity ?? 0),
    status: binderItem.status,
    tradeMode: binderItem.tradeMode,
    visibility: binderItem.visibility,
    localTradeAllowed: binderItem.localTradeAllowed !== false,
    postalTradeAllowed: binderItem.postalTradeAllowed !== false,
    copyState: collectionItem.copyState,
    conditionCode: collectionItem.conditionCode,
    grading: grading ? {
      gradingCompany: grading.gradingCompany ?? null,
      gradeLabel: grading.gradeLabel ?? null,
      gradeValue: grading.gradeValue == null ? null : Number(grading.gradeValue),
    } : null,
    createdAt: isoStamp(binderItem.createdAt),
    updatedAt: isoStamp(binderItem.updatedAt),
    card,
  };
}

function cardProjection(row) {
  const fateCardId = row.card_identity_id ?? row.fateCardId ?? null;
  if (!fateCardId) return null;
  return Object.freeze({
    fateCardId,
    name: row.card_name ?? row.cardName ?? null,
    collectorNumber: row.collector_number ?? row.collectorNumber ?? null,
    variantCode: row.variant_code ?? row.variantCode ?? null,
    languageCode: row.language_code ?? row.languageCode ?? null,
    setName: row.set_name ?? row.setName ?? null,
  });
}

function postgresOffer(row) {
  return {
    id: row.id,
    binderItemId: row.id,
    userId: row.user_id,
    fateCardId: row.card_identity_id,
    tradeQuantity: Number(row.trade_quantity ?? 0),
    status: row.status,
    tradeMode: row.trade_mode,
    visibility: row.visibility,
    localTradeAllowed: row.local_trade_allowed !== false,
    postalTradeAllowed: row.postal_trade_allowed !== false,
    copyState: row.copy_state,
    conditionCode: row.condition_code,
    grading: row.grading_company ? {
      gradingCompany: row.grading_company,
      gradeLabel: row.grade_label ?? null,
      gradeValue: row.grade_value == null ? null : Number(row.grade_value),
    } : null,
    createdAt: isoStamp(row.created_at),
    updatedAt: isoStamp(row.updated_at),
    card: cardProjection(row),
  };
}

function networkFileOffers(state, { userId = null, excludeUserId = null, targetCardIds = null } = {}) {
  const binderState = state.traderBinder || { binders: {}, items: {} };
  const collection = state.traderCollection || { items: {}, grading: {} };
  const targets = targetCardIds ? new Set(targetCardIds) : null;
  const offers = [];
  for (const item of Object.values(binderState.items || {})) {
    const binder = binderState.binders?.[item.binderId];
    const owned = collection.items?.[item.collectionItemId];
    if (!binder || !owned) continue;
    if (userId && binder.userId !== userId) continue;
    if (excludeUserId && binder.userId === excludeUserId) continue;
    if (binder.visibility !== 'network' || binder.status !== 'active') continue;
    if (item.visibility !== 'network' || item.status !== 'available') continue;
    if (owned.status !== 'active' || Number(owned.tradeQuantity || 0) <= 0) continue;
    if (targets && !targets.has(owned.fateCardId)) continue;
    const grading = collection.grading?.[owned.id] || owned.grading || null;
    offers.push(offerFromParts({
      binderItem: item,
      binder,
      collectionItem: owned,
      grading,
      card: null,
    }));
  }
  return offers;
}

function fileWants(state, userIds) {
  const wantedUsers = new Set(userIds);
  const collection = state.traderCollection || { wants: {} };
  const constraints = state.traderBinder?.wantConstraints || {};
  const rows = [];
  for (const want of Object.values(collection.wants || {})) {
    if (!want.active || !wantedUsers.has(want.userId)) continue;
    rows.push(wantFromRow(want, constraints[want.id] || null));
  }
  return rows;
}

async function postgresOffers(store, { userId = null, excludeUserId = null, targetCardIds = null, limit = 500 } = {}) {
  const pool = await store.pool();
  const params = [];
  const where = [
    "b.visibility='network'",
    "b.status='active'",
    "bi.visibility='network'",
    "bi.status='available'",
    "ci.status='active'",
    'ci.trade_quantity>0',
  ];
  if (userId) {
    params.push(userId);
    where.push(`b.user_id=$${params.length}`);
  }
  if (excludeUserId) {
    params.push(excludeUserId);
    where.push(`b.user_id<>$${params.length}`);
  }
  if (Array.isArray(targetCardIds) && targetCardIds.length) {
    params.push(targetCardIds);
    where.push(`ci.card_identity_id=ANY($${params.length}::text[])`);
  }
  params.push(Math.max(1, Math.min(1000, Number(limit) || 500)));
  const sql = `SELECT bi.id,b.user_id,ci.card_identity_id,ci.trade_quantity,bi.status,bi.trade_mode,bi.visibility,
      bi.local_trade_allowed,bi.postal_trade_allowed,bi.created_at,bi.updated_at,
      ci.copy_state,ci.condition_code,g.grading_company,g.grade_label,g.grade_value,
      ci_card.collector_number,ci_card.variant_code,ci_card.language_code,p.name AS card_name,s.name AS set_name
    FROM fatedrop_trade_binder_items bi
    JOIN fatedrop_trade_binders b ON b.id=bi.binder_id
    JOIN fatedrop_collection_items ci ON ci.id=bi.collection_item_id
    LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id=ci.id
    JOIN fatedrop_card_identities ci_card ON ci_card.id=ci.card_identity_id AND ci_card.verification_status='verified'
    JOIN fatedrop_card_printings p ON p.id=ci_card.printing_id AND p.verification_status='verified'
    JOIN fatedrop_card_sets s ON s.id=ci_card.set_id AND s.verification_status='verified'
    WHERE ${where.join(' AND ')}
    ORDER BY bi.updated_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map(postgresOffer);
}

async function postgresWants(store, userIds) {
  if (!userIds.length) return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT w.*,wc.copy_state,wc.minimum_condition_code,wc.minimum_grade,wc.maximum_grade,
      wc.accepted_grading_companies,wc.local_trade_allowed,wc.postal_trade_allowed
    FROM fatedrop_card_wants w
    LEFT JOIN fatedrop_want_constraints wc ON wc.want_id=w.id
    WHERE w.active=true AND w.user_id=ANY($1::text[])
    ORDER BY w.updated_at DESC LIMIT 5000`, [userIds]);
  return rows.map((row) => wantFromRow(row));
}

function groupWants(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const bucket = grouped.get(row.userId) || [];
    bucket.push(row);
    grouped.set(row.userId, bucket);
  }
  return grouped;
}

function publicOpportunity(result, card) {
  return Object.freeze({
    id: result.fingerprint,
    opportunityClass: result.opportunityClass,
    headline: result.headline,
    score: result.score,
    scoreBreakdown: result.scoreBreakdown,
    targetRelation: result.targetRelation,
    verifiedReciprocal: result.verifiedReciprocal,
    compatibleReciprocal: result.compatibleReciprocal,
    fateTradeFoundEligible: result.fateTradeFoundEligible,
    targetQuantitySatisfied: result.targetQuantitySatisfied,
    evidence: result.evidence,
    commonTradeMethods: result.commonTradeMethods,
    targetCardId: result.targetCardId,
    offeredTargetCardId: result.offeredTargetCardId,
    candidateOfferId: result.candidateOfferId,
    reciprocalMatchCount: Array.isArray(result.reciprocalEvidence) ? result.reciprocalEvidence.length : 0,
    card: card || null,
  });
}

export async function findTradeOpportunities(store, { userId, limit = 50 } = {}) {
  const safe = safeLimit(limit);
  if (!userId) return Object.freeze({ opportunities: [], count: 0, searchedWants: 0, networkOffersConsidered: 0 });

  let seekerWants;
  let seekerOffers;
  let candidateOffers;
  let candidateWants;

  if (typeof store?.read === 'function') {
    const state = await store.read();
    seekerWants = fileWants(state, [userId]);
    const targetCardIds = seekerWants.map((want) => want.fateCardId);
    seekerOffers = networkFileOffers(state, { userId });
    candidateOffers = networkFileOffers(state, { excludeUserId: userId, targetCardIds }).slice(0, 1000);
    const candidateUserIds = [...new Set(candidateOffers.map((offer) => offer.userId))];
    candidateWants = fileWants(state, candidateUserIds);
  } else if (typeof store?.pool === 'function') {
    seekerWants = await postgresWants(store, [userId]);
    const targetCardIds = seekerWants.map((want) => want.fateCardId);
    seekerOffers = await postgresOffers(store, { userId, limit: 1000 });
    candidateOffers = targetCardIds.length
      ? await postgresOffers(store, { excludeUserId: userId, targetCardIds, limit: 1000 })
      : [];
    const candidateUserIds = [...new Set(candidateOffers.map((offer) => offer.userId))];
    candidateWants = await postgresWants(store, candidateUserIds);
  } else {
    return Object.freeze({ opportunities: [], count: 0, searchedWants: 0, networkOffersConsidered: 0 });
  }

  const candidateWantsByUser = groupWants(candidateWants);
  const targetWantByCard = new Map(seekerWants.map((want) => [want.fateCardId, want]));
  const evaluated = [];

  for (const offer of candidateOffers) {
    const targetWant = targetWantByCard.get(offer.fateCardId);
    if (!targetWant) continue;
    const result = evaluateTradeOpportunity({
      seeker: { userId, offers: seekerOffers },
      targetWant,
      candidate: { userId: offer.userId, offer, wants: candidateWantsByUser.get(offer.userId) || [] },
    });
    if (result.finderEligible) evaluated.push({ result, card: offer.card });
  }

  const ranked = rankTradeOpportunities(evaluated.map((row) => row.result));
  const cardByFingerprint = new Map(evaluated.map((row) => [row.result.fingerprint, row.card]));
  const opportunities = ranked.slice(0, safe).map((result) => publicOpportunity(result, cardByFingerprint.get(result.fingerprint)));

  return Object.freeze({
    opportunities: Object.freeze(opportunities),
    count: opportunities.length,
    searchedWants: seekerWants.length,
    networkOffersConsidered: candidateOffers.length,
  });
}
