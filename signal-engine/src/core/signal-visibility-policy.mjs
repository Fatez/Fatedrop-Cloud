export const SIGNAL_DELIVERY_POLICIES = Object.freeze({
  INTERRUPT: "interrupt",
  INBOX_ONLY: "inbox_only",
  HISTORY_ONLY: "history_only",
  ANOMALY_QUARANTINE: "anomaly_quarantine",
});

const VALID_POLICIES = new Set(Object.values(SIGNAL_DELIVERY_POLICIES));
const PUBLIC_HIDDEN_POLICIES = new Set([
  SIGNAL_DELIVERY_POLICIES.HISTORY_ONLY,
  SIGNAL_DELIVERY_POLICIES.ANOMALY_QUARANTINE,
]);

export const LOW_VALUE_WHISPER_KINDS = new Set([
  "catalogue_price_change",
  "inventory_quantity_change",
  "stock_watch_refresh",
]);

function evidenceEntries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function signalKindFrom(signal = {}) {
  if (typeof signal.kind === "string" && signal.kind.trim()) return signal.kind.trim();
  const value = evidenceEntries(signal.evidence).find((entry) => entry?.kind === "signal_kind")?.value;
  return typeof value === "string" ? value.trim() : "";
}

export function explicitSignalDeliveryPolicy(signal = {}) {
  if (VALID_POLICIES.has(signal.deliveryPolicy)) return signal.deliveryPolicy;
  const entries = evidenceEntries(signal.evidence);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "delivery_policy" && VALID_POLICIES.has(entry.value)) return entry.value;
  }
  if (signal.deliverySuppressed === true) return SIGNAL_DELIVERY_POLICIES.HISTORY_ONLY;
  return null;
}

export function effectiveSignalDeliveryPolicy(signal = {}) {
  const explicit = explicitSignalDeliveryPolicy(signal);
  if (explicit) return explicit;
  const state = String(signal.state || "").toLowerCase();
  const kind = signalKindFrom(signal);
  if (state === "whisper" && LOW_VALUE_WHISPER_KINDS.has(kind)) return SIGNAL_DELIVERY_POLICIES.INBOX_ONLY;
  return SIGNAL_DELIVERY_POLICIES.INTERRUPT;
}

export function signalPubliclyVisible(signal = {}) {
  return !PUBLIC_HIDDEN_POLICIES.has(effectiveSignalDeliveryPolicy(signal));
}

export function signalInterruptEligible(signal = {}) {
  return effectiveSignalDeliveryPolicy(signal) === SIGNAL_DELIVERY_POLICIES.INTERRUPT;
}

export function withSignalDeliveryPolicy(signal, policy, reason = null) {
  if (!VALID_POLICIES.has(policy)) throw new TypeError(`Unsupported signal delivery policy: ${policy}`);
  const observedAt = Number(signal?.detectedAt) || Math.floor(Date.now() / 1000);
  const evidence = evidenceEntries(signal?.evidence)
    .filter((entry) => entry?.kind !== "delivery_policy" && entry?.kind !== "delivery_policy_reason");
  evidence.push({ kind: "delivery_policy", value: policy, observedAt });
  if (reason) evidence.push({ kind: "delivery_policy_reason", value: String(reason), observedAt });
  return {
    ...signal,
    deliveryPolicy: policy,
    deliverySuppressed: policy !== SIGNAL_DELIVERY_POLICIES.INTERRUPT,
    evidence,
  };
}

export function defaultSignalDeliveryPolicy({ state, kind } = {}) {
  if (String(state || "").toLowerCase() === "whisper" && LOW_VALUE_WHISPER_KINDS.has(String(kind || ""))) {
    return SIGNAL_DELIVERY_POLICIES.INBOX_ONLY;
  }
  return SIGNAL_DELIVERY_POLICIES.INTERRUPT;
}

function commonPriceRatio(signals) {
  const buckets = new Map();
  let samples = 0;
  for (const signal of signals) {
    const before = Number(signal.previousPricePence);
    const after = Number(signal.pricePence);
    if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after <= 0) continue;
    samples += 1;
    const bucket = (Math.round((after / before) * 1000) / 1000).toFixed(3);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  const [ratio = null, count = 0] = [...buckets.entries()].sort((left, right) => right[1] - left[1])[0] || [];
  return { ratio, count, samples, share: samples ? count / samples : 0 };
}

export function applySignalBurstSafety(signals = [], { anomalyMinimum = 25, interruptWhisperMaximum = 25 } = {}) {
  let safeSignals = [...signals];
  const priceChanges = safeSignals.filter((signal) => String(signal.state).toLowerCase() === "whisper" && signalKindFrom(signal) === "catalogue_price_change");
  const ratio = commonPriceRatio(priceChanges);
  let quarantined = 0;
  let burstHeld = 0;

  if (priceChanges.length >= anomalyMinimum && ratio.samples >= anomalyMinimum && ratio.share >= 0.8) {
    const priceIds = new Set(priceChanges.map((signal) => signal.id));
    safeSignals = safeSignals.map((signal) => {
      if (!priceIds.has(signal.id)) return signal;
      quarantined += 1;
      return withSignalDeliveryPolicy(signal, SIGNAL_DELIVERY_POLICIES.ANOMALY_QUARANTINE, `coherent_price_step:${ratio.ratio}:${ratio.count}_of_${ratio.samples}`);
    });
  }

  const interruptWhispers = safeSignals.filter((signal) => String(signal.state).toLowerCase() === "whisper" && signalInterruptEligible(signal));
  if (interruptWhispers.length > interruptWhisperMaximum) {
    const heldIds = new Set(interruptWhispers.map((signal) => signal.id));
    safeSignals = safeSignals.map((signal) => {
      if (!heldIds.has(signal.id)) return signal;
      burstHeld += 1;
      return withSignalDeliveryPolicy(signal, SIGNAL_DELIVERY_POLICIES.INBOX_ONLY, `whisper_scan_burst:${interruptWhispers.length}`);
    });
  }

  return {
    signals: safeSignals,
    diagnostics: {
      total: safeSignals.length,
      priceChanges: priceChanges.length,
      coherentPriceRatio: ratio.ratio,
      coherentPriceShare: ratio.share,
      quarantined,
      burstHeld,
    },
  };
}

function safeAlias(alias) {
  const value = String(alias || "s");
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new TypeError("SQL alias must be an identifier");
  return value;
}

export function signalDeliveryPolicySql(alias = "s") {
  const table = safeAlias(alias);
  return `(CASE
    WHEN COALESCE((
      SELECT policy_item->>'value'
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${table}.evidence)='array' THEN ${table}.evidence ELSE '[]'::jsonb END) WITH ORDINALITY AS policy(policy_item, position)
      WHERE policy_item->>'kind'='delivery_policy'
      ORDER BY position DESC
      LIMIT 1
    ), '') IN ('interrupt','inbox_only','history_only','anomaly_quarantine')
    THEN COALESCE((
      SELECT policy_item->>'value'
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${table}.evidence)='array' THEN ${table}.evidence ELSE '[]'::jsonb END) WITH ORDINALITY AS policy(policy_item, position)
      WHERE policy_item->>'kind'='delivery_policy'
      ORDER BY position DESC
      LIMIT 1
    ), 'interrupt')
    WHEN ${table}.state='whisper' AND COALESCE((
      SELECT kind_item->>'value'
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${table}.evidence)='array' THEN ${table}.evidence ELSE '[]'::jsonb END) WITH ORDINALITY AS kinds(kind_item, position)
      WHERE kind_item->>'kind'='signal_kind'
      ORDER BY position DESC
      LIMIT 1
    ), '') IN ('catalogue_price_change','inventory_quantity_change','stock_watch_refresh')
    THEN 'inbox_only'
    ELSE 'interrupt'
  END)`;
}

export function publicSignalSqlFilter(alias = "s") {
  return `${signalDeliveryPolicySql(alias)} NOT IN ('history_only','anomaly_quarantine')`;
}

export function discordEligibleSignalSqlFilter(alias = "s") {
  return `${signalDeliveryPolicySql(alias)} = 'interrupt'`;
}

export function validVanishedSqlFilter(alias = "s") {
  const table = safeAlias(alias);
  return `(
    ${table}.state <> 'vanished'
    OR (
      ${table}.offer_id IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM fatedrop_signals manifested
          WHERE manifested.offer_id=${table}.offer_id
            AND manifested.state='manifested'
            AND manifested.detected_at < ${table}.detected_at
            AND NOT EXISTS (
              SELECT 1 FROM fatedrop_signals intervening_vanished
              WHERE intervening_vanished.offer_id=${table}.offer_id
                AND intervening_vanished.state='vanished'
                AND intervening_vanished.detected_at > manifested.detected_at
                AND intervening_vanished.detected_at < ${table}.detected_at
            )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${table}.evidence)='array' THEN ${table}.evidence ELSE '[]'::jsonb END) prior_live
          WHERE prior_live->>'kind'='prior_live_confirmation'
            AND prior_live->>'value'='persisted_purchasable_offer'
            AND COALESCE(prior_live->>'observedAt','') ~ '^[0-9]+$'
            AND (prior_live->>'observedAt')::bigint > 0
            AND (prior_live->>'observedAt')::bigint < ${table}.detected_at
        )
      )
    )
  )`;
}
