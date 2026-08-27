import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createSafeExchangeAgreement,
  nextSafeExchangeState,
  SAFE_EXCHANGE_EVENTS,
  SAFE_EXCHANGE_METHODS,
  SAFE_EXCHANGE_STATES,
} from './protocol.mjs';

const MAX_HUB_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HUB_SESSION_TTL_MS = 10 * 60 * 1000;

function safeState(state) {
  state.traderSafeExchange ||= { exchanges: {}, events: [], hubSessions: {}, hubs: {} };
  state.traderSafeExchange.exchanges ||= {};
  state.traderSafeExchange.events ||= [];
  state.traderSafeExchange.hubSessions ||= {};
  state.traderSafeExchange.hubs ||= {};
  return state.traderSafeExchange;
}

function trustState(state) {
  state.traderTrust ||= { evidence: [] };
  state.traderTrust.evidence ||= [];
  return state.traderTrust;
}

function text(value) { return value == null ? '' : String(value).trim(); }
function bool(value) { return value === true; }
function nowInt(value = Date.now()) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.trunc(parsed) : Date.now(); }
function sha256(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
function secureToken() { return randomBytes(32).toString('base64url'); }
function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left || ''), 'hex');
    const b = Buffer.from(String(right || ''), 'hex');
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

function stableAgreementHash(agreement) {
  const canonical = {
    transactionId: agreement.transactionId,
    partyAUserId: agreement.partyAUserId,
    partyBUserId: agreement.partyBUserId,
    method: agreement.method,
    hubId: agreement.hubId,
    partyACommitment: agreement.partyACommitment,
    partyBCommitment: agreement.partyBCommitment,
  };
  return sha256(JSON.stringify(canonical));
}

function dbExchange(row = {}) {
  if (!row?.id) return null;
  return {
    id: row.id,
    transactionId: row.id,
    partyAUserId: row.party_a_user_id ?? row.partyAUserId,
    partyBUserId: row.party_b_user_id ?? row.partyBUserId,
    method: row.method,
    hubId: row.hub_id ?? row.hubId ?? null,
    partyACommitment: row.party_a_commitment_json ?? row.partyACommitment,
    partyBCommitment: row.party_b_commitment_json ?? row.partyBCommitment,
    agreementHash: row.agreement_hash ?? row.agreementHash,
    state: row.state,
    partyAAgreed: bool(row.party_a_agreed ?? row.partyAAgreed),
    partyBAgreed: bool(row.party_b_agreed ?? row.partyBAgreed),
    partyACheckedIn: bool(row.party_a_checked_in ?? row.partyACheckedIn),
    partyBCheckedIn: bool(row.party_b_checked_in ?? row.partyBCheckedIn),
    partyATrackingRef: row.party_a_tracking_ref ?? row.partyATrackingRef ?? null,
    partyBTrackingRef: row.party_b_tracking_ref ?? row.partyBTrackingRef ?? null,
    partyADelivered: bool(row.party_a_delivered ?? row.partyADelivered),
    partyBDelivered: bool(row.party_b_delivered ?? row.partyBDelivered),
    partyAInspected: bool(row.party_a_inspected ?? row.partyAInspected),
    partyBInspected: bool(row.party_b_inspected ?? row.partyBInspected),
    partyAConfirmed: bool(row.party_a_confirmed ?? row.partyAConfirmed),
    partyBConfirmed: bool(row.party_b_confirmed ?? row.partyBConfirmed),
    revision: Number(row.revision ?? 1),
    createdAt: Number(row.created_at ?? row.createdAt ?? 0),
    updatedAt: Number(row.updated_at ?? row.updatedAt ?? 0),
    completedAt: row.completed_at == null ? (row.completedAt ?? null) : Number(row.completed_at),
    cancelledAt: row.cancelled_at == null ? (row.cancelledAt ?? null) : Number(row.cancelled_at),
  };
}

function publicExchange(exchange) {
  const row = dbExchange(exchange);
  if (!row) return null;
  return Object.freeze({ ...row });
}

function agreementFromExchange(exchange) {
  return Object.freeze({
    transactionId: exchange.id,
    partyAUserId: exchange.partyAUserId,
    partyBUserId: exchange.partyBUserId,
    partyACommitment: exchange.partyACommitment,
    partyBCommitment: exchange.partyBCommitment,
    method: exchange.method,
    hubId: exchange.hubId,
  });
}

function assertMember(exchange, userId) {
  if (!exchange || (exchange.partyAUserId !== userId && exchange.partyBUserId !== userId)) {
    const error = new Error('Safe Exchange not found');
    error.code = 'SAFE_EXCHANGE_NOT_FOUND';
    throw error;
  }
  return exchange.partyAUserId === userId ? 'A' : 'B';
}

function validateAssetShape(commitment, side) {
  for (const asset of commitment?.assets || []) {
    if (!text(asset.collectionItemId)) {
      const error = new TypeError(`${side} card commitments require collectionItemId`);
      error.code = 'COLLECTION_ITEM_REQUIRED';
      throw error;
    }
  }
}

async function validateFileCommitmentOwnership(store, state, userId, commitment) {
  const collection = state.traderCollection || { collections: {}, items: {}, grading: {} };
  for (const asset of commitment.assets || []) {
    const item = collection.items?.[asset.collectionItemId];
    const parent = item ? collection.collections?.[item.collectionId] : null;
    if (!item || !parent || parent.userId !== userId || item.status !== 'active') {
      const error = new Error('Committed collection item is not owned by this trader');
      error.code = 'COMMITMENT_NOT_OWNED';
      throw error;
    }
    if (item.fateCardId !== asset.fateCardId) {
      const error = new Error('Committed collection item does not match the canonical card identity');
      error.code = 'COMMITMENT_CARD_MISMATCH';
      throw error;
    }
    if (Number(item.tradeQuantity || 0) < Number(asset.quantity || 0)) {
      const error = new Error('Committed quantity exceeds the available trade quantity');
      error.code = 'COMMITMENT_QUANTITY_UNAVAILABLE';
      throw error;
    }
  }
}

async function validatePostgresCommitmentOwnership(client, userId, commitment) {
  const ids = [...new Set((commitment.assets || []).map((asset) => asset.collectionItemId))];
  if (!ids.length) return;
  const { rows } = await client.query(`SELECT i.id,c.user_id,i.card_identity_id,i.trade_quantity,i.status,ci.verification_status
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    JOIN fatedrop_card_identities ci ON ci.id=i.card_identity_id
    WHERE i.id=ANY($1::text[])
    FOR UPDATE OF i`, [ids]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const asset of commitment.assets || []) {
    const row = byId.get(asset.collectionItemId);
    if (!row || row.user_id !== userId || row.status !== 'active') {
      const error = new Error('Committed collection item is not owned by this trader');
      error.code = 'COMMITMENT_NOT_OWNED';
      throw error;
    }
    if (row.verification_status !== 'verified' || row.card_identity_id !== asset.fateCardId) {
      const error = new Error('Committed collection item does not match a verified canonical card identity');
      error.code = 'COMMITMENT_CARD_MISMATCH';
      throw error;
    }
    if (Number(row.trade_quantity || 0) < Number(asset.quantity || 0)) {
      const error = new Error('Committed quantity exceeds the available trade quantity');
      error.code = 'COMMITMENT_QUANTITY_UNAVAILABLE';
      throw error;
    }
  }
}

function makeExchange({ agreement, now }) {
  return {
    id: agreement.transactionId,
    partyAUserId: agreement.partyAUserId,
    partyBUserId: agreement.partyBUserId,
    method: agreement.method,
    hubId: agreement.hubId,
    partyACommitment: agreement.partyACommitment,
    partyBCommitment: agreement.partyBCommitment,
    agreementHash: stableAgreementHash(agreement),
    state: SAFE_EXCHANGE_STATES.DRAFT,
    partyAAgreed: false,
    partyBAgreed: false,
    partyACheckedIn: false,
    partyBCheckedIn: false,
    partyATrackingRef: null,
    partyBTrackingRef: null,
    partyADelivered: false,
    partyBDelivered: false,
    partyAInspected: false,
    partyBInspected: false,
    partyAConfirmed: false,
    partyBConfirmed: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
  };
}

function eventRow({ exchange, actorUserId = null, eventType, fromState = null, payload = {}, now }) {
  return {
    id: `ftxe_${randomUUID()}`,
    exchangeId: exchange.id,
    actorUserId,
    eventType,
    fromState,
    toState: exchange.state,
    payload,
    occurredAt: now,
  };
}

function completedTrustRows(exchange, now) {
  const evidenceType = exchange.method === SAFE_EXCHANGE_METHODS.HUB ? 'hub_trade' : 'tracked_postal_trade';
  return [
    {
      id: `fte_${randomUUID()}`,
      dedupeKey: `exchange:${exchange.id}:user:${exchange.partyAUserId}:completed`,
      userId: exchange.partyAUserId,
      counterpartyUserId: exchange.partyBUserId,
      exchangeId: exchange.id,
      evidenceType,
      status: 'verified',
      tradeValuePence: 0,
      evidenceSource: 'safe_exchange_completion',
      occurredAt: now,
      metadata: {},
    },
    {
      id: `fte_${randomUUID()}`,
      dedupeKey: `exchange:${exchange.id}:user:${exchange.partyBUserId}:completed`,
      userId: exchange.partyBUserId,
      counterpartyUserId: exchange.partyAUserId,
      exchangeId: exchange.id,
      evidenceType,
      status: 'verified',
      tradeValuePence: 0,
      evidenceSource: 'safe_exchange_completion',
      occurredAt: now,
      metadata: {},
    },
  ];
}

async function approvedHubFile(state, hubId) {
  return safeState(state).hubs?.[hubId]?.status === 'approved';
}

async function approvedHubPostgres(client, hubId) {
  const { rows } = await client.query(`SELECT h.id
    FROM fatedrop_fate_hubs h
    JOIN fatedrop_retailer_locations l ON l.id=h.id
    WHERE h.id=$1 AND h.status='approved' AND l.verification='official_retailer_branch'
    LIMIT 1`, [hubId]);
  return Boolean(rows[0]);
}

export async function createSafeExchangeInStore(store, { userId, input = {}, now = Date.now() } = {}) {
  const transactionId = `ftx_${randomUUID()}`;
  const partyBUserId = text(input.partyBUserId);
  const partyACommitment = input.partyACommitment || {};
  const partyBCommitment = input.partyBCommitment || {};
  validateAssetShape(partyACommitment, 'partyA');
  validateAssetShape(partyBCommitment, 'partyB');
  const result = createSafeExchangeAgreement({
    transactionId,
    partyAUserId: userId,
    partyBUserId,
    partyACommitment,
    partyBCommitment,
    method: input.method,
    hubId: input.hubId,
  });
  if (!result.ok) {
    const error = new TypeError(`Invalid Safe Exchange agreement: ${result.errors.join(', ')}`);
    error.code = 'INVALID_SAFE_EXCHANGE';
    error.details = result.errors;
    throw error;
  }
  const agreement = result.agreement;
  const timestamp = nowInt(now);

  if (typeof store?.mutate === 'function' && typeof store?.read === 'function') {
    const snapshot = await store.read();
    if (agreement.method === SAFE_EXCHANGE_METHODS.HUB && !(await approvedHubFile(snapshot, agreement.hubId))) {
      const error = new Error('The selected location is not an approved Fate Hub');
      error.code = 'HUB_NOT_APPROVED';
      throw error;
    }
    await validateFileCommitmentOwnership(store, snapshot, agreement.partyAUserId, partyACommitment);
    await validateFileCommitmentOwnership(store, snapshot, agreement.partyBUserId, partyBCommitment);
    return store.mutate((state) => {
      const data = safeState(state);
      const exchange = makeExchange({ agreement, now: timestamp });
      data.exchanges[exchange.id] = exchange;
      data.events.push(eventRow({ exchange, actorUserId: userId, eventType: 'created', now: timestamp }));
      return publicExchange(exchange);
    });
  }

  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const users = await client.query('SELECT id FROM fatedrop_users WHERE id=ANY($1::text[])', [[agreement.partyAUserId, agreement.partyBUserId]]);
      if (users.rows.length !== 2) {
        const error = new Error('Both Safe Exchange parties must be valid FateDrop users');
        error.code = 'PARTY_NOT_FOUND';
        throw error;
      }
      if (agreement.method === SAFE_EXCHANGE_METHODS.HUB && !(await approvedHubPostgres(client, agreement.hubId))) {
        const error = new Error('The selected location is not an approved Fate Hub');
        error.code = 'HUB_NOT_APPROVED';
        throw error;
      }
      await validatePostgresCommitmentOwnership(client, agreement.partyAUserId, partyACommitment);
      await validatePostgresCommitmentOwnership(client, agreement.partyBUserId, partyBCommitment);
      const exchange = makeExchange({ agreement, now: timestamp });
      await client.query(`INSERT INTO fatedrop_safe_exchanges
        (id,party_a_user_id,party_b_user_id,method,hub_id,party_a_commitment_json,party_b_commitment_json,agreement_hash,state,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$10)`,
      [exchange.id,exchange.partyAUserId,exchange.partyBUserId,exchange.method,exchange.hubId,JSON.stringify(exchange.partyACommitment),JSON.stringify(exchange.partyBCommitment),exchange.agreementHash,exchange.state,timestamp]);
      const event = eventRow({ exchange, actorUserId: userId, eventType: 'created', now: timestamp });
      await client.query(`INSERT INTO fatedrop_safe_exchange_events
        (id,exchange_id,actor_user_id,event_type,from_state,to_state,payload_json,occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [event.id,event.exchangeId,event.actorUserId,event.eventType,event.fromState,event.toState,JSON.stringify(event.payload),event.occurredAt]);
      await client.query('COMMIT');
      return publicExchange(exchange);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  throw new Error('Safe Exchange persistence is unavailable');
}

export async function getSafeExchangeFromStore(store, { userId, exchangeId } = {}) {
  if (typeof store?.read === 'function') {
    const state = await store.read();
    const exchange = publicExchange(safeState(state).exchanges?.[exchangeId]);
    if (!exchange || (exchange.partyAUserId !== userId && exchange.partyBUserId !== userId)) return null;
    return exchange;
  }
  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const { rows } = await pool.query(`SELECT * FROM fatedrop_safe_exchanges
      WHERE id=$1 AND (party_a_user_id=$2 OR party_b_user_id=$2) LIMIT 1`, [exchangeId,userId]);
    return rows[0] ? publicExchange(rows[0]) : null;
  }
  return null;
}

export async function listSafeExchangesFromStore(store, { userId, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  if (typeof store?.read === 'function') {
    const state = await store.read();
    return Object.values(safeState(state).exchanges || {})
      .map(publicExchange)
      .filter((exchange) => exchange.partyAUserId === userId || exchange.partyBUserId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, safeLimit);
  }
  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const { rows } = await pool.query(`SELECT * FROM fatedrop_safe_exchanges
      WHERE party_a_user_id=$1 OR party_b_user_id=$1
      ORDER BY updated_at DESC LIMIT $2`, [userId,safeLimit]);
    return rows.map(publicExchange);
  }
  return [];
}

function actionMutation(exchange, { side, action, body = {}, hubProof = null, now }) {
  const next = { ...exchange, revision: exchange.revision + 1, updatedAt: now };
  const fromState = exchange.state;
  let protocolEvent = null;

  if (action === 'agree') {
    next[`party${side}Agreed`] = true;
    if (next.partyAAgreed && next.partyBAgreed && next.state === SAFE_EXCHANGE_STATES.DRAFT) protocolEvent = SAFE_EXCHANGE_EVENTS.AGREE;
  } else if (action === 'check_in') {
    if (next.method !== SAFE_EXCHANGE_METHODS.HUB) throw Object.assign(new Error('Hub check-in is not valid for this exchange'), { code: 'TRANSITION_NOT_ALLOWED' });
    next[`party${side}CheckedIn`] = true;
    if (next.partyACheckedIn && next.partyBCheckedIn && next.state === SAFE_EXCHANGE_STATES.AGREED) protocolEvent = SAFE_EXCHANGE_EVENTS.HUB_CHECK_IN;
  } else if (action === 'dispatch') {
    if (next.method !== SAFE_EXCHANGE_METHODS.POSTAL) throw Object.assign(new Error('Postal dispatch is not valid for this exchange'), { code: 'TRANSITION_NOT_ALLOWED' });
    const trackingRef = text(body.trackingRef);
    if (!trackingRef) throw new TypeError('trackingRef is required');
    next[`party${side}TrackingRef`] = trackingRef;
    if (next.partyATrackingRef && next.partyBTrackingRef && next.state === SAFE_EXCHANGE_STATES.AGREED) protocolEvent = SAFE_EXCHANGE_EVENTS.POST;
  } else if (action === 'delivered') {
    if (next.method !== SAFE_EXCHANGE_METHODS.POSTAL || next.state !== SAFE_EXCHANGE_STATES.IN_TRANSIT) throw Object.assign(new Error('Delivery confirmation is not valid in the current state'), { code: 'TRANSITION_NOT_ALLOWED' });
    next[`party${side}Delivered`] = true;
  } else if (action === 'inspect') {
    if (![SAFE_EXCHANGE_STATES.CHECKED_IN, SAFE_EXCHANGE_STATES.IN_TRANSIT].includes(next.state)) throw Object.assign(new Error('Inspection is not valid in the current state'), { code: 'TRANSITION_NOT_ALLOWED' });
    next[`party${side}Inspected`] = true;
    if (next.partyAInspected && next.partyBInspected) protocolEvent = SAFE_EXCHANGE_EVENTS.INSPECT;
  } else if (action === 'begin_confirmation') {
    if (next.state !== SAFE_EXCHANGE_STATES.INSPECTED) throw Object.assign(new Error('Confirmation cannot begin yet'), { code: 'TRANSITION_NOT_ALLOWED' });
    protocolEvent = SAFE_EXCHANGE_EVENTS.BEGIN_CONFIRMATION;
  } else if (action === 'confirm') {
    if (next.state !== SAFE_EXCHANGE_STATES.CONFIRMING) throw Object.assign(new Error('Completion confirmation is not open'), { code: 'TRANSITION_NOT_ALLOWED' });
    next[`party${side}Confirmed`] = true;
    if (next.partyAConfirmed && next.partyBConfirmed) protocolEvent = SAFE_EXCHANGE_EVENTS.COMPLETE;
  } else if (action === 'cancel') {
    protocolEvent = SAFE_EXCHANGE_EVENTS.CANCEL;
  } else {
    throw new TypeError('Unsupported Safe Exchange action');
  }

  if (protocolEvent) {
    const transition = nextSafeExchangeState({
      state: fromState,
      event: protocolEvent,
      agreement: agreementFromExchange(next),
      context: {
        partyAAgreed: next.partyAAgreed,
        partyBAgreed: next.partyBAgreed,
        partyACheckedIn: next.partyACheckedIn,
        partyBCheckedIn: next.partyBCheckedIn,
        partyATrackingRef: next.partyATrackingRef,
        partyBTrackingRef: next.partyBTrackingRef,
        partyADelivered: next.partyADelivered,
        partyBDelivered: next.partyBDelivered,
        partyAInspected: next.partyAInspected,
        partyBInspected: next.partyBInspected,
        partyAConfirmed: next.partyAConfirmed,
        partyBConfirmed: next.partyBConfirmed,
        hubProof,
        now,
      },
    });
    if (!transition.ok) {
      const error = new Error(`Safe Exchange transition rejected: ${transition.reason}`);
      error.code = 'TRANSITION_NOT_ALLOWED';
      error.details = { reason: transition.reason };
      throw error;
    }
    next.state = transition.state;
    if (next.state === SAFE_EXCHANGE_STATES.COMPLETED) next.completedAt = now;
    if (next.state === SAFE_EXCHANGE_STATES.CANCELLED) next.cancelledAt = now;
  }

  return { next, fromState, protocolEvent };
}

function verifyFileHubProof(data, exchange, proof, now) {
  const sessionId = text(proof?.sessionId);
  const token = text(proof?.token);
  const session = data.hubSessions?.[sessionId];
  if (!session || !token || session.exchangeId !== exchange.id || session.hubId !== exchange.hubId || session.usedAt != null) return null;
  if (now < session.issuedAt || now >= session.expiresAt) return null;
  if (!safeEqualHex(session.proofTokenHash, sha256(token))) return null;
  return {
    transactionId: exchange.id,
    hubId: exchange.hubId,
    sessionId,
    issuedAt: new Date(session.issuedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

async function verifyPostgresHubProof(client, exchange, proof, now) {
  const sessionId = text(proof?.sessionId);
  const token = text(proof?.token);
  if (!sessionId || !token) return null;
  const { rows } = await client.query(`SELECT * FROM fatedrop_hub_sessions
    WHERE id=$1 AND exchange_id=$2 AND hub_id=$3 AND used_at IS NULL
    LIMIT 1 FOR UPDATE`, [sessionId,exchange.id,exchange.hubId]);
  const session = rows[0];
  if (!session || now < Number(session.issued_at) || now >= Number(session.expires_at)) return null;
  if (!safeEqualHex(session.proof_token_hash, sha256(token))) return null;
  return {
    transactionId: exchange.id,
    hubId: exchange.hubId,
    sessionId,
    issuedAt: new Date(Number(session.issued_at)).toISOString(),
    expiresAt: new Date(Number(session.expires_at)).toISOString(),
  };
}

async function writePostgresExchange(client, exchange) {
  await client.query(`UPDATE fatedrop_safe_exchanges SET
      state=$2,party_a_agreed=$3,party_b_agreed=$4,party_a_checked_in=$5,party_b_checked_in=$6,
      party_a_tracking_ref=$7,party_b_tracking_ref=$8,party_a_delivered=$9,party_b_delivered=$10,
      party_a_inspected=$11,party_b_inspected=$12,party_a_confirmed=$13,party_b_confirmed=$14,
      revision=$15,updated_at=$16,completed_at=$17,cancelled_at=$18
    WHERE id=$1`, [exchange.id,exchange.state,exchange.partyAAgreed,exchange.partyBAgreed,exchange.partyACheckedIn,exchange.partyBCheckedIn,
    exchange.partyATrackingRef,exchange.partyBTrackingRef,exchange.partyADelivered,exchange.partyBDelivered,
    exchange.partyAInspected,exchange.partyBInspected,exchange.partyAConfirmed,exchange.partyBConfirmed,
    exchange.revision,exchange.updatedAt,exchange.completedAt,exchange.cancelledAt]);
}

async function writePostgresEvent(client, event) {
  await client.query(`INSERT INTO fatedrop_safe_exchange_events
    (id,exchange_id,actor_user_id,event_type,from_state,to_state,payload_json,occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [event.id,event.exchangeId,event.actorUserId,event.eventType,event.fromState,event.toState,JSON.stringify(event.payload),event.occurredAt]);
}

async function writePostgresCompletionTrust(client, exchange, now) {
  for (const row of completedTrustRows(exchange, now)) {
    await client.query(`INSERT INTO fatedrop_trader_trust_evidence
      (id,dedupe_key,user_id,counterparty_user_id,exchange_id,evidence_type,evidence_status,trade_value_pence,evidence_source,occurred_at,metadata_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'{}'::jsonb)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [row.id,row.dedupeKey,row.userId,row.counterpartyUserId,row.exchangeId,row.evidenceType,row.status,row.evidenceSource,row.occurredAt]);
  }
}

export async function actOnSafeExchangeInStore(store, { userId, exchangeId, action, body = {}, now = Date.now() } = {}) {
  const timestamp = nowInt(now);
  if (typeof store?.mutate === 'function' && typeof store?.read === 'function') {
    const snapshot = await store.read();
    const data = safeState(snapshot);
    const current = publicExchange(data.exchanges?.[exchangeId]);
    const side = assertMember(current, userId);
    let hubProof = null;
    if (action === 'check_in') {
      hubProof = verifyFileHubProof(data, current, body.hubProof, timestamp);
      if (!hubProof) throw Object.assign(new Error('Hub proof is invalid, expired, already used, or not bound to this exchange'), { code: 'HUB_PROOF_INVALID' });
    }
    const mutation = actionMutation(current, { side, action, body, hubProof, now: timestamp });
    return store.mutate((state) => {
      const mutable = safeState(state);
      mutable.exchanges[exchangeId] = mutation.next;
      if (action === 'check_in' && mutation.next.state === SAFE_EXCHANGE_STATES.CHECKED_IN) {
        mutable.hubSessions[hubProof.sessionId].usedAt = timestamp;
      }
      if (mutation.next.state === SAFE_EXCHANGE_STATES.COMPLETED && current.state !== SAFE_EXCHANGE_STATES.COMPLETED) {
        const trust = trustState(state);
        for (const row of completedTrustRows(mutation.next, timestamp)) {
          if (!trust.evidence.some((item) => item.dedupeKey === row.dedupeKey)) trust.evidence.push(row);
        }
      }
      const event = eventRow({ exchange: mutation.next, actorUserId: userId, eventType: action, fromState: mutation.fromState, payload: { stateAdvanced: mutation.fromState !== mutation.next.state }, now: timestamp });
      mutable.events.push(event);
      return publicExchange(mutation.next);
    });
  }

  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM fatedrop_safe_exchanges WHERE id=$1 LIMIT 1 FOR UPDATE', [exchangeId]);
      const current = publicExchange(result.rows[0]);
      const side = assertMember(current, userId);
      let hubProof = null;
      if (action === 'check_in') {
        hubProof = await verifyPostgresHubProof(client, current, body.hubProof, timestamp);
        if (!hubProof) throw Object.assign(new Error('Hub proof is invalid, expired, already used, or not bound to this exchange'), { code: 'HUB_PROOF_INVALID' });
      }
      const mutation = actionMutation(current, { side, action, body, hubProof, now: timestamp });
      await writePostgresExchange(client, mutation.next);
      if (action === 'check_in' && mutation.next.state === SAFE_EXCHANGE_STATES.CHECKED_IN) {
        await client.query('UPDATE fatedrop_hub_sessions SET used_at=$2 WHERE id=$1 AND used_at IS NULL', [hubProof.sessionId,timestamp]);
      }
      if (mutation.next.state === SAFE_EXCHANGE_STATES.COMPLETED && current.state !== SAFE_EXCHANGE_STATES.COMPLETED) {
        await writePostgresCompletionTrust(client, mutation.next, timestamp);
      }
      const event = eventRow({ exchange: mutation.next, actorUserId: userId, eventType: action, fromState: mutation.fromState, payload: { stateAdvanced: mutation.fromState !== mutation.next.state }, now: timestamp });
      await writePostgresEvent(client, event);
      await client.query('COMMIT');
      return publicExchange(mutation.next);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  throw new Error('Safe Exchange persistence is unavailable');
}

export async function issueHubSessionInStore(store, { exchangeId, hubId, ttlMs = DEFAULT_HUB_SESSION_TTL_MS, now = Date.now() } = {}) {
  const timestamp = nowInt(now);
  const ttl = Math.max(60_000, Math.min(MAX_HUB_SESSION_TTL_MS, Math.trunc(Number(ttlMs) || DEFAULT_HUB_SESSION_TTL_MS)));
  const expiresAt = timestamp + ttl;
  const token = secureToken();
  const sessionId = `fths_${randomUUID()}`;
  const proofTokenHash = sha256(token);

  if (typeof store?.mutate === 'function' && typeof store?.read === 'function') {
    const snapshot = await store.read();
    const data = safeState(snapshot);
    const exchange = publicExchange(data.exchanges?.[exchangeId]);
    if (!exchange || exchange.method !== SAFE_EXCHANGE_METHODS.HUB || exchange.hubId !== hubId || exchange.state !== SAFE_EXCHANGE_STATES.AGREED) {
      throw Object.assign(new Error('Exchange is not eligible for a Fate Hub session'), { code: 'HUB_SESSION_NOT_ALLOWED' });
    }
    if (!(await approvedHubFile(snapshot, hubId))) throw Object.assign(new Error('Fate Hub is not approved'), { code: 'HUB_NOT_APPROVED' });
    await store.mutate((state) => {
      safeState(state).hubSessions[sessionId] = { id:sessionId,exchangeId,hubId,proofTokenHash,issuedAt:timestamp,expiresAt,usedAt:null,createdAt:timestamp };
    });
  } else if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM fatedrop_safe_exchanges WHERE id=$1 LIMIT 1 FOR UPDATE', [exchangeId]);
      const exchange = publicExchange(rows[0]);
      if (!exchange || exchange.method !== SAFE_EXCHANGE_METHODS.HUB || exchange.hubId !== hubId || exchange.state !== SAFE_EXCHANGE_STATES.AGREED) {
        throw Object.assign(new Error('Exchange is not eligible for a Fate Hub session'), { code: 'HUB_SESSION_NOT_ALLOWED' });
      }
      if (!(await approvedHubPostgres(client, hubId))) throw Object.assign(new Error('Fate Hub is not approved'), { code: 'HUB_NOT_APPROVED' });
      await client.query(`INSERT INTO fatedrop_hub_sessions
        (id,exchange_id,hub_id,proof_token_hash,issued_at,expires_at,used_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,NULL,$5)`, [sessionId,exchangeId,hubId,proofTokenHash,timestamp,expiresAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } else {
    throw new Error('Safe Exchange persistence is unavailable');
  }

  return Object.freeze({
    transactionId: exchangeId,
    hubId,
    sessionId,
    issuedAt: new Date(timestamp).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    token,
  });
}

export async function approveFateHubInStore(store, { hubId, approvedBy = 'internal', now = Date.now() } = {}) {
  const timestamp = nowInt(now);
  if (!text(hubId)) throw new TypeError('hubId is required');
  if (typeof store?.mutate === 'function') {
    return store.mutate((state) => {
      const data = safeState(state);
      data.hubs[hubId] = { id: hubId, status: 'approved', approvedBy, createdAt: data.hubs[hubId]?.createdAt || timestamp, updatedAt: timestamp };
      return data.hubs[hubId];
    });
  }
  if (typeof store?.pool === 'function') {
    const pool = await store.pool();
    const location = await pool.query(`SELECT id FROM fatedrop_retailer_locations
      WHERE id=$1 AND verification='official_retailer_branch' LIMIT 1`, [hubId]);
    if (!location.rows[0]) throw Object.assign(new Error('Only a verified official retailer branch can be approved as a Fate Hub'), { code: 'HUB_LOCATION_NOT_VERIFIED' });
    const { rows } = await pool.query(`INSERT INTO fatedrop_fate_hubs (id,status,approved_by,created_at,updated_at)
      VALUES ($1,'approved',$2,$3,$3)
      ON CONFLICT (id) DO UPDATE SET status='approved',approved_by=EXCLUDED.approved_by,updated_at=EXCLUDED.updated_at
      RETURNING *`, [hubId,approvedBy,timestamp]);
    return rows[0];
  }
  throw new Error('Safe Exchange persistence is unavailable');
}
