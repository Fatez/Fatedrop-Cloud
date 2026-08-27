import { randomUUID } from 'node:crypto';
import { scoreFateTrust } from './scoring.mjs';

export const TRUST_EVIDENCE_TYPES = Object.freeze({
  HUB_TRADE: 'hub_trade',
  TRACKED_POSTAL_TRADE: 'tracked_postal_trade',
  DUAL_CONFIRMED_TRADE: 'dual_confirmed_trade',
  FAILED_TRADE: 'failed_trade',
  VERIFIED_POSITIVE_FEEDBACK: 'verified_positive_feedback',
  SUBSTANTIATED_NEGATIVE_FEEDBACK: 'substantiated_negative_feedback',
  MINOR_FULFILMENT: 'minor_fulfilment',
  SIGNIFICANT_DISPUTE: 'significant_dispute',
  CONFIRMED_FRAUD: 'confirmed_fraud',
});

export const TRUST_EVIDENCE_STATUSES = Object.freeze({
  VERIFIED: 'verified',
  SUBSTANTIATED: 'substantiated',
  UNSUBSTANTIATED: 'unsubstantiated',
});

const SUCCESS_TYPES = new Set([
  TRUST_EVIDENCE_TYPES.HUB_TRADE,
  TRUST_EVIDENCE_TYPES.TRACKED_POSTAL_TRADE,
  TRUST_EVIDENCE_TYPES.DUAL_CONFIRMED_TRADE,
]);
const NEGATIVE_TYPES = new Set([
  TRUST_EVIDENCE_TYPES.FAILED_TRADE,
  TRUST_EVIDENCE_TYPES.SUBSTANTIATED_NEGATIVE_FEEDBACK,
  TRUST_EVIDENCE_TYPES.MINOR_FULFILMENT,
  TRUST_EVIDENCE_TYPES.SIGNIFICANT_DISPUTE,
  TRUST_EVIDENCE_TYPES.CONFIRMED_FRAUD,
]);
const ALL_TYPES = new Set(Object.values(TRUST_EVIDENCE_TYPES));
const ALL_STATUSES = new Set(Object.values(TRUST_EVIDENCE_STATUSES));

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function epochMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function trustState(state) {
  state.traderTrust ||= { evidence: [] };
  state.traderTrust.evidence ||= [];
  return state.traderTrust;
}

function normalizeEvidence(input = {}) {
  const evidenceType = String(input.evidenceType || '').trim().toLowerCase();
  const status = String(input.status || '').trim().toLowerCase();
  if (!ALL_TYPES.has(evidenceType)) throw new TypeError('Unsupported FateTrust evidence type');
  if (!ALL_STATUSES.has(status)) throw new TypeError('Unsupported FateTrust evidence status');
  const userId = String(input.userId || '').trim();
  if (!userId) throw new TypeError('FateTrust evidence requires a userId');
  const counterpartyUserId = String(input.counterpartyUserId || '').trim() || null;
  if (counterpartyUserId && counterpartyUserId === userId) throw new TypeError('FateTrust counterparty must be a different user');
  const occurredAt = Math.trunc(finiteNonNegative(input.occurredAt, Date.now()));
  const tradeValuePence = Math.trunc(finiteNonNegative(input.tradeValuePence, 0));
  return Object.freeze({
    id: String(input.id || `fte_${randomUUID()}`),
    dedupeKey: String(input.dedupeKey || '').trim() || null,
    userId,
    counterpartyUserId,
    exchangeId: String(input.exchangeId || '').trim() || null,
    evidenceType,
    status,
    tradeValuePence,
    evidenceSource: String(input.evidenceSource || 'fatedrop_cloud').trim(),
    occurredAt,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  });
}

function evidenceRow(row = {}) {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key ?? row.dedupeKey ?? null,
    userId: row.user_id ?? row.userId,
    counterpartyUserId: row.counterparty_user_id ?? row.counterpartyUserId ?? null,
    exchangeId: row.exchange_id ?? row.exchangeId ?? null,
    evidenceType: row.evidence_type ?? row.evidenceType,
    status: row.evidence_status ?? row.status,
    tradeValuePence: Number(row.trade_value_pence ?? row.tradeValuePence ?? 0),
    evidenceSource: row.evidence_source ?? row.evidenceSource ?? null,
    occurredAt: Number(row.occurred_at ?? row.occurredAt ?? 0),
    metadata: row.metadata_json ?? row.metadata ?? {},
  };
}

function aggregate(rows = []) {
  const evidence = {
    hubTrades: 0,
    trackedPostalTrades: 0,
    dualConfirmedTrades: 0,
    failedTrades: 0,
    uniqueCounterparties: 0,
    verifiedTradeValuePence: 0,
    largestVerifiedTradeValuePence: 0,
    positiveVerifiedFeedback: 0,
    substantiatedNegativeFeedback: 0,
    substantiatedMinorFulfilments: 0,
    substantiatedSignificantDisputes: 0,
    confirmedFraudFindings: 0,
  };
  const counterparties = new Set();

  for (const raw of rows) {
    const row = evidenceRow(raw);
    const verified = row.status === TRUST_EVIDENCE_STATUSES.VERIFIED;
    const substantiated = row.status === TRUST_EVIDENCE_STATUSES.SUBSTANTIATED;

    if (verified && SUCCESS_TYPES.has(row.evidenceType)) {
      if (row.evidenceType === TRUST_EVIDENCE_TYPES.HUB_TRADE) evidence.hubTrades += 1;
      if (row.evidenceType === TRUST_EVIDENCE_TYPES.TRACKED_POSTAL_TRADE) evidence.trackedPostalTrades += 1;
      if (row.evidenceType === TRUST_EVIDENCE_TYPES.DUAL_CONFIRMED_TRADE) evidence.dualConfirmedTrades += 1;
      evidence.verifiedTradeValuePence += row.tradeValuePence;
      evidence.largestVerifiedTradeValuePence = Math.max(evidence.largestVerifiedTradeValuePence, row.tradeValuePence);
      if (row.counterpartyUserId) counterparties.add(row.counterpartyUserId);
    }

    if (verified && row.evidenceType === TRUST_EVIDENCE_TYPES.VERIFIED_POSITIVE_FEEDBACK) {
      evidence.positiveVerifiedFeedback += 1;
    }
    if (substantiated && row.evidenceType === TRUST_EVIDENCE_TYPES.FAILED_TRADE) evidence.failedTrades += 1;
    if (substantiated && row.evidenceType === TRUST_EVIDENCE_TYPES.SUBSTANTIATED_NEGATIVE_FEEDBACK) evidence.substantiatedNegativeFeedback += 1;
    if (substantiated && row.evidenceType === TRUST_EVIDENCE_TYPES.MINOR_FULFILMENT) evidence.substantiatedMinorFulfilments += 1;
    if (substantiated && row.evidenceType === TRUST_EVIDENCE_TYPES.SIGNIFICANT_DISPUTE) evidence.substantiatedSignificantDisputes += 1;
    if (substantiated && row.evidenceType === TRUST_EVIDENCE_TYPES.CONFIRMED_FRAUD) evidence.confirmedFraudFindings += 1;
  }

  evidence.uniqueCounterparties = counterparties.size;
  return evidence;
}

function accountContext(user = {}, now = Date.now()) {
  const createdAt = epochMs(user.created_at ?? user.createdAt);
  const accountAgeDays = createdAt == null ? 0 : Math.max(0, (now - createdAt) / 86_400_000);
  return {
    accountAgeDays,
    // Current FateDrop account schema does not prove these signals. Unknown stays false/zero.
    emailVerified: false,
    phoneVerified: false,
    mfaEnabled: false,
    deviceIntegrity: 0,
  };
}

async function loadFileEvidence(store, userId) {
  const state = await store.read();
  return (trustState(state).evidence || []).filter((row) => row.userId === userId);
}

async function loadPostgresEvidence(store, userId) {
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT id,dedupe_key,user_id,counterparty_user_id,exchange_id,evidence_type,evidence_status,
      trade_value_pence,evidence_source,occurred_at,metadata_json
    FROM fatedrop_trader_trust_evidence
    WHERE user_id=$1
    ORDER BY occurred_at ASC`, [userId]);
  return rows;
}

async function loadAccount(store, userId) {
  if (typeof store?.read === 'function') {
    const state = await store.read();
    const user = state?.traderUsers?.[userId] || state?.users?.[userId] || null;
    return user || { id: userId, createdAt: Date.now() };
  }
  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const { rows } = await pool.query('SELECT id,created_at FROM fatedrop_users WHERE id=$1 LIMIT 1', [userId]);
    return rows[0] || null;
  }
  return null;
}

export async function getTrustProfileFromStore(store, { userId, now = Date.now() } = {}) {
  if (!userId) return null;
  const account = await loadAccount(store, userId);
  if (!account) return null;
  const rows = typeof store?.read === 'function'
    ? await loadFileEvidence(store, userId)
    : typeof store?.pool === 'function'
      ? await loadPostgresEvidence(store, userId)
      : [];
  const evidence = aggregate(rows);
  const trust = scoreFateTrust({ evidence, account: accountContext(account, now) });
  return Object.freeze({
    userId,
    ...trust,
    verifiedTradeValuePence: evidence.verifiedTradeValuePence,
    largestVerifiedTradeValuePence: evidence.largestVerifiedTradeValuePence,
    uniqueCounterparties: evidence.uniqueCounterparties,
    evidenceCounts: Object.freeze({
      hubTrades: evidence.hubTrades,
      trackedPostalTrades: evidence.trackedPostalTrades,
      dualConfirmedTrades: evidence.dualConfirmedTrades,
      failedTrades: evidence.failedTrades,
      positiveVerifiedFeedback: evidence.positiveVerifiedFeedback,
      substantiatedNegativeFeedback: evidence.substantiatedNegativeFeedback,
      substantiatedMinorFulfilments: evidence.substantiatedMinorFulfilments,
      substantiatedSignificantDisputes: evidence.substantiatedSignificantDisputes,
      confirmedFraudFindings: evidence.confirmedFraudFindings,
    }),
  });
}

export async function getPublicTrustProfilesFromStore(store, { userIds = [], now = Date.now() } = {}) {
  const unique = [...new Set(userIds.map((value) => String(value || '').trim()).filter(Boolean))];
  const profiles = await Promise.all(unique.map((userId) => getTrustProfileFromStore(store, { userId, now })));
  return new Map(profiles.filter(Boolean).map((profile) => [profile.userId, Object.freeze({
    score: profile.score,
    level: profile.level,
    restricted: profile.restricted,
    effectiveTrades: profile.effectiveTrades,
    evidenceConfidence: profile.evidenceConfidence,
  })]));
}

export async function recordTrustEvidenceInStore(store, input) {
  const row = normalizeEvidence(input);
  if (typeof store?.mutate === 'function') {
    return store.mutate((state) => {
      const data = trustState(state);
      if (row.dedupeKey) {
        const existing = data.evidence.find((item) => item.dedupeKey === row.dedupeKey);
        if (existing) return evidenceRow(existing);
      }
      data.evidence.push(row);
      return evidenceRow(row);
    });
  }
  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const { rows } = await pool.query(`INSERT INTO fatedrop_trader_trust_evidence
      (id,dedupe_key,user_id,counterparty_user_id,exchange_id,evidence_type,evidence_status,trade_value_pence,evidence_source,occurred_at,metadata_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key
      RETURNING *`, [row.id,row.dedupeKey,row.userId,row.counterpartyUserId,row.exchangeId,row.evidenceType,row.status,row.tradeValuePence,row.evidenceSource,row.occurredAt,JSON.stringify(row.metadata)]);
    return evidenceRow(rows[0]);
  }
  throw new Error('FateTrust persistence is unavailable');
}

export async function recordCompletedExchangeTrustEvidence(store, {
  exchangeId,
  partyAUserId,
  partyBUserId,
  method,
  verifiedTradeValuePence = 0,
  occurredAt = Date.now(),
} = {}) {
  const evidenceType = method === 'hub'
    ? TRUST_EVIDENCE_TYPES.HUB_TRADE
    : method === 'postal'
      ? TRUST_EVIDENCE_TYPES.TRACKED_POSTAL_TRADE
      : TRUST_EVIDENCE_TYPES.DUAL_CONFIRMED_TRADE;
  const value = Math.trunc(finiteNonNegative(verifiedTradeValuePence, 0));
  const common = {
    exchangeId,
    evidenceType,
    status: TRUST_EVIDENCE_STATUSES.VERIFIED,
    tradeValuePence: value,
    evidenceSource: 'safe_exchange_completion',
    occurredAt,
  };
  const [partyA, partyB] = await Promise.all([
    recordTrustEvidenceInStore(store, { ...common, dedupeKey: `exchange:${exchangeId}:user:${partyAUserId}:completed`, userId: partyAUserId, counterpartyUserId: partyBUserId }),
    recordTrustEvidenceInStore(store, { ...common, dedupeKey: `exchange:${exchangeId}:user:${partyBUserId}:completed`, userId: partyBUserId, counterpartyUserId: partyAUserId }),
  ]);
  return Object.freeze({ partyA, partyB });
}

export function trustEvidenceAffectsScore({ evidenceType, status } = {}) {
  if (SUCCESS_TYPES.has(evidenceType)) return status === TRUST_EVIDENCE_STATUSES.VERIFIED;
  if (evidenceType === TRUST_EVIDENCE_TYPES.VERIFIED_POSITIVE_FEEDBACK) return status === TRUST_EVIDENCE_STATUSES.VERIFIED;
  if (NEGATIVE_TYPES.has(evidenceType)) return status === TRUST_EVIDENCE_STATUSES.SUBSTANTIATED;
  return false;
}
