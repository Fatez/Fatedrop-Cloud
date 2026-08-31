import { availabilityEffectForStage, canonicalEpisodeTransition } from "../core/canonical-stock-episode.mjs";
import { stableId } from "../core/normalize.mjs";
import { effectiveSignalDeliveryPolicy, SIGNAL_DELIVERY_POLICIES } from "../core/signal-visibility-policy.mjs";

function text(value) {
  return String(value ?? "").trim();
}

function signalKind(signal) {
  if (text(signal?.kind)) return text(signal.kind);
  const entry = (Array.isArray(signal?.evidence) ? signal.evidence : [])
    .find((item) => item?.kind === "signal_kind" && text(item?.value));
  return text(entry?.value) || null;
}

function dbEpisode(row) {
  if (!row) return null;
  return {
    id: row.id,
    cycleNumber: Number(row.cycle_number),
    episodeState: row.episode_state,
    availabilityState: row.availability_state,
    manifestedAt: row.manifested_at == null ? null : Number(row.manifested_at),
    latestEventAt: Number(row.latest_event_at),
  };
}

function canonicalScope(signal) {
  const offerId = text(signal?.offerId);
  const productId = text(signal?.productId);
  const retailerId = text(signal?.retailerId);
  if (!offerId || !productId || !retailerId) return null;
  return {
    type: "online",
    key: `offer:${offerId}`,
    offerId,
    productId,
    retailerId,
    locationId: null,
  };
}

async function insertConflict(client, signal, scope, reason, now) {
  const scopeType = scope?.type || "online";
  const scopeKey = scope?.key || `unresolved:${text(signal?.id) || "unknown"}`;
  const conflictId = stableId("epc", text(signal?.id), reason);
  await client.query(
    `INSERT INTO fatedrop_stock_episode_conflicts
      (id,signal_id,scope_type,scope_key,offer_id,product_id,retailer_id,stage,reason,occurred_at,signal_payload,resolution_state,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'pending',$12)
     ON CONFLICT (signal_id) DO NOTHING`,
    [
      conflictId,
      text(signal?.id) || conflictId,
      scopeType,
      scopeKey,
      text(signal?.offerId) || null,
      text(signal?.productId) || null,
      text(signal?.retailerId) || null,
      text(signal?.state) || null,
      reason,
      Number.isFinite(Number(signal?.detectedAt)) ? Math.floor(Number(signal.detectedAt)) : null,
      JSON.stringify(signal || {}),
      now,
    ],
  );
  return conflictId;
}

async function insertSignal(client, signal) {
  return client.query(
    `INSERT INTO fatedrop_signals
      (id,state,product_id,offer_id,retailer_id,retailer_name,title,product_type,url,image_url,price_pence,rrp_pence,postage_pence,delivered_price_pence,markup_percent,stock_status,previous_stock_status,confidence,detected_at,reason,evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      signal.id,
      signal.state,
      signal.productId,
      signal.offerId,
      signal.retailerId,
      signal.retailerName,
      signal.title,
      signal.productType || "other",
      signal.url || "",
      signal.imageUrl || null,
      signal.pricePence ?? null,
      signal.rrpPence ?? null,
      signal.postagePence ?? null,
      signal.deliveredPricePence ?? null,
      signal.markupPercent ?? null,
      signal.stockStatus || "unknown",
      signal.previousStockStatus || null,
      signal.confidence ?? 0,
      signal.detectedAt,
      signal.reason || "",
      JSON.stringify(Array.isArray(signal.evidence) ? signal.evidence : []),
    ],
  );
}

async function createEpisode(client, scope, transition, signal, now) {
  const episodeId = stableId("ep", scope.type, scope.key, String(transition.cycleNumber));
  const manifestedAt = signal.state === "manifested" ? signal.detectedAt : null;
  await client.query(
    `INSERT INTO fatedrop_stock_episodes
      (id,scope_type,scope_key,offer_id,product_id,retailer_id,location_id,cycle_number,episode_state,availability_state,opened_at,manifested_at,vanished_at,latest_event_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$11,$13,$13)`,
    [
      episodeId,
      scope.type,
      scope.key,
      scope.offerId,
      scope.productId,
      scope.retailerId,
      scope.locationId,
      transition.cycleNumber,
      transition.episodeState,
      transition.availabilityState,
      signal.detectedAt,
      manifestedAt,
      now,
    ],
  );
  return episodeId;
}

async function updateEpisode(client, currentEpisode, transition, signal, now) {
  const manifestedAt = signal.state === "manifested" ? signal.detectedAt : null;
  const vanishedAt = signal.state === "vanished" ? signal.detectedAt : null;
  await client.query(
    `UPDATE fatedrop_stock_episodes
     SET episode_state=$2,
         availability_state=$3,
         manifested_at=CASE WHEN $4::bigint IS NULL THEN manifested_at ELSE COALESCE(manifested_at,$4::bigint) END,
         vanished_at=CASE WHEN $5::bigint IS NULL THEN vanished_at ELSE $5::bigint END,
         latest_event_at=GREATEST(latest_event_at,$6),
         updated_at=$7
     WHERE id=$1`,
    [currentEpisode.id, transition.episodeState, transition.availabilityState, manifestedAt, vanishedAt, signal.detectedAt, now],
  );
  return currentEpisode.id;
}

async function appendEpisodeEvent(client, { episodeId, signal, now }) {
  const eventId = stableId("epe", signal.id);
  await client.query(
    `INSERT INTO fatedrop_stock_episode_events
      (id,episode_id,signal_id,stage,availability_effect,signal_kind,occurred_at,evidence,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (signal_id) DO NOTHING`,
    [
      eventId,
      episodeId,
      signal.id,
      signal.state,
      availabilityEffectForStage(signal.state),
      signalKind(signal),
      signal.detectedAt,
      JSON.stringify(Array.isArray(signal.evidence) ? signal.evidence : []),
      now,
    ],
  );
}

async function appendDiscordObligation(client, { episodeId, signal, now }) {
  const policy = effectiveSignalDeliveryPolicy(signal);
  const destinationKey = `lifecycle:${signal.state}`;
  const idempotencyKey = `lifecycle:v1:${signal.id}:discord:${destinationKey}`;
  const outboxId = stableId("sdo", idempotencyKey);
  const state = policy === SIGNAL_DELIVERY_POLICIES.INTERRUPT ? "pending" : "suppressed";
  const lastError = state === "suppressed" ? `policy_${policy}` : null;
  const maxAgeByStage = { whisper: 20 * 60, echo: 5 * 60, manifested: 15 * 60, vanished: 30 * 60 };
  const expiresAt = Number(signal.detectedAt) + (maxAgeByStage[signal.state] || 15 * 60);
  await client.query(
    `INSERT INTO fatedrop_signal_delivery_outbox
      (id,idempotency_key,signal_id,episode_id,channel,destination_key,delivery_policy,state,attempt_count,available_at,expires_at,created_at,updated_at,last_error)
     VALUES ($1,$2,$3,$4,'discord',$5,$6,$7,0,$8,$9,$8,$8,$10)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [outboxId, idempotencyKey, signal.id, episodeId, destinationKey, policy, state, now, expiresAt, lastError],
  );
  return { outboxId, state, policy };
}

export async function persistCanonicalSignals(client, signals, { now = Math.floor(Date.now() / 1000) } = {}) {
  const ordered = [...(signals || [])]
    .sort((left, right) => Number(left?.detectedAt || 0) - Number(right?.detectedAt || 0)
      || text(left?.id).localeCompare(text(right?.id)));
  const acceptedSignalIds = [];
  const conflictSignalIds = [];
  const deduplicatedSignalIds = [];
  const outboxIds = [];

  for (const signal of ordered) {
    const signalId = text(signal?.id);
    const scope = canonicalScope(signal);
    if (!signalId || !scope) {
      await insertConflict(client, signal, scope, "canonical_scope_incomplete", now);
      if (signalId) conflictSignalIds.push(signalId);
      continue;
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fatedrop:episode:${scope.type}:${scope.key}`]);

    const existingEvent = await client.query(
      "SELECT episode_id FROM fatedrop_stock_episode_events WHERE signal_id=$1",
      [signalId],
    );
    if (existingEvent.rows[0]) {
      deduplicatedSignalIds.push(signalId);
      continue;
    }

    const latest = await client.query(
      `SELECT * FROM fatedrop_stock_episodes
       WHERE scope_type=$1 AND scope_key=$2
       ORDER BY cycle_number DESC
       LIMIT 1
       FOR UPDATE`,
      [scope.type, scope.key],
    );
    const currentEpisode = dbEpisode(latest.rows[0]);
    const transition = canonicalEpisodeTransition({
      stage: text(signal.state).toLowerCase(),
      currentEpisode,
      occurredAt: signal.detectedAt,
    });
    if (!transition.accepted) {
      await insertConflict(client, signal, scope, transition.conflictReason, now);
      conflictSignalIds.push(signalId);
      continue;
    }

    await insertSignal(client, signal);
    const episodeId = transition.create
      ? await createEpisode(client, scope, transition, signal, now)
      : await updateEpisode(client, currentEpisode, transition, signal, now);
    await appendEpisodeEvent(client, { episodeId, signal, now });
    const obligation = await appendDiscordObligation(client, { episodeId, signal, now });

    acceptedSignalIds.push(signalId);
    outboxIds.push(obligation.outboxId);
  }

  return {
    acceptedSignalIds,
    conflictSignalIds,
    deduplicatedSignalIds,
    outboxIds,
  };
}
