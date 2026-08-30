from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


signals = "signal-engine/src/core/signals.mjs"
replace(
    signals,
    'function signalEvidence(evidence, { kind, state, alertClass, retailerSku, observedAt, priorLiveConfirmation = null, preparation = null, productAlert = null }) {',
    'function signalEvidence(evidence, { kind, state, alertClass, retailerSku, observedAt, priorLiveConfirmation = null, preparation = null, productAlert = null, deliverySuppressed = false }) {',
)
replace(
    signals,
    '''    ...(priorLiveConfirmation ? [{
      kind: "prior_live_confirmation",
      value: "persisted_purchasable_offer",
      observedAt: priorLiveConfirmation.observedAt,
      firstAvailableAt: priorLiveConfirmation.firstAvailableAt,
      stockStatus: priorLiveConfirmation.stockStatus,
      confidence: priorLiveConfirmation.confidence,
    }] : []),
  ];''',
    '''    ...(priorLiveConfirmation ? [{
      kind: "prior_live_confirmation",
      value: "persisted_purchasable_offer",
      observedAt: priorLiveConfirmation.observedAt,
      firstAvailableAt: priorLiveConfirmation.firstAvailableAt,
      stockStatus: priorLiveConfirmation.stockStatus,
      confidence: priorLiveConfirmation.confidence,
    }] : []),
    ...(deliverySuppressed ? [{ kind: "delivery_policy", value: "history_only", observedAt }] : []),
  ];''',
)
replace(
    signals,
    'function buildSignal({ state, kind, reason, currentOffer, previousOffer, preparation, productAlert, policy, now, priorLive = null }) {',
    '''function activeManifestedAt(previousOffer) {
  if (previousOffer?.lifecycleHistoryLoaded !== true) return null;
  const manifestedAt = Number(previousOffer.latestManifestedAt);
  const vanishedAt = Number(previousOffer.latestVanishedAt);
  if (!Number.isFinite(manifestedAt) || manifestedAt <= 0) return null;
  if (Number.isFinite(vanishedAt) && vanishedAt > 0 && vanishedAt >= manifestedAt) return null;
  return manifestedAt;
}

function needsReconciledManifestedAnchor(previousOffer, currentOffer) {
  return previousOffer?.lifecycleHistoryLoaded === true
    && effectivePurchasable(previousOffer)
    && effectivePurchasable(currentOffer)
    && activeManifestedAt(previousOffer) == null;
}

function buildSignal({ state, kind, reason, currentOffer, previousOffer, preparation, productAlert, policy, now, priorLive = null, deliverySuppressed = false }) {''',
)
replace(
    signals,
    '''    confidence: currentOffer.stockConfidence ?? 0.5,
    detectedAt: now,
    reason,''',
    '''    confidence: currentOffer.stockConfidence ?? 0.5,
    detectedAt: now,
    reason,
    deliverySuppressed,''',
)
replace(
    signals,
    '''      productAlert,
    }),''',
    '''      productAlert,
      deliverySuppressed,
    }),''',
)
replace(
    signals,
    '''export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return null;

  const productAlert''',
    '''export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  const productAlert''',
)
replace(
    signals,
    '''  let reason = null;
  let priorLive = null;

  // CANONICAL FATEDROP LIFECYCLE CONTRACT''',
    '''  let reason = null;
  let priorLive = null;
  let deliverySuppressed = false;

  // CANONICAL FATEDROP LIFECYCLE CONTRACT''',
)
replace(
    signals,
    '''  if (!previousOffer) {
    if (nowPurchasable) {''',
    '''  if (isBaseline) {
    if (!nowPurchasable) return null;
    state = SignalState.MANIFESTED;
    kind = "baseline_live_anchor";
    reason = "Baseline scan verified purchasable availability; canonical Manifested anchor recorded without alert delivery";
    deliverySuppressed = true;
  } else if (needsReconciledManifestedAnchor(previousOffer, currentOffer)) {
    state = SignalState.MANIFESTED;
    kind = "reconciled_live_anchor";
    reason = "Verified live offer had no active Manifested lifecycle anchor; current confirmation starts a truthful live window";
    deliverySuppressed = true;
  } else if (!previousOffer) {
    if (nowPurchasable) {''',
)
replace(
    signals,
    '  return buildSignal({ state, kind, reason, currentOffer, previousOffer, preparation, productAlert, policy, now, priorLive });',
    '  return buildSignal({ state, kind, reason, currentOffer, previousOffer, preparation, productAlert, policy, now, priorLive, deliverySuppressed });',
)

prev = "signal-engine/src/core/previous-state.mjs"
replace(
    prev,
    '''    lastWhisperAt: row.last_whisper_at ? Number(row.last_whisper_at) : null,
    evidence:''',
    '''    lastWhisperAt: row.last_whisper_at ? Number(row.last_whisper_at) : null,
    lifecycleHistoryLoaded: true,
    latestManifestedAt: row.latest_manifested_at ? Number(row.latest_manifested_at) : null,
    latestVanishedAt: row.latest_vanished_at ? Number(row.latest_vanished_at) : null,
    evidence:''',
)
replace(
    prev,
    '''          SELECT o.*, latest.evidence AS observation_evidence, whisper.detected_at AS last_whisper_at
          FROM fatedrop_retail_offers o''',
    '''          SELECT o.*, latest.evidence AS observation_evidence, whisper.detected_at AS last_whisper_at, lifecycle.latest_manifested_at, lifecycle.latest_vanished_at
          FROM fatedrop_retail_offers o''',
)
replace(
    prev,
    '''          ) whisper ON true
          WHERE o.offer_id = ANY($1::text[])''',
    '''          ) whisper ON true
          LEFT JOIN LATERAL (
            SELECT
              MAX(signal.detected_at) FILTER (WHERE signal.state = 'manifested') AS latest_manifested_at,
              MAX(signal.detected_at) FILTER (WHERE signal.state = 'vanished') AS latest_vanished_at
            FROM fatedrop_signals signal
            WHERE signal.offer_id = o.offer_id
              AND signal.state IN ('manifested','vanished')
          ) lifecycle ON true
          WHERE o.offer_id = ANY($1::text[])''',
)

discord = "signal-engine/src/notifications/discord.mjs"
replace(
    discord,
    '''export function isDiscordSignal(signal) {
  return Boolean(signal && DISCORD_SIGNAL_STATES.has(signal.state));
}''',
    '''export function isDiscordSignal(signal) {
  return Boolean(signal && signal.deliverySuppressed !== true && DISCORD_SIGNAL_STATES.has(signal.state));
}''',
)

tests = "signal-engine/tests/signals.test.mjs"
replace(
    tests,
    'test("quiet baseline emits no signal",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100}),null));',
    '''test("quiet baseline persists a Manifested history anchor without alert delivery",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"baseline_live_anchor");
  assert.equal(signal.deliverySuppressed,true);
  assert.equal(signal.evidence.some((entry)=>entry?.kind==="delivery_policy"&&entry?.value==="history_only"),true);
});

test("quiet baseline still emits nothing for unavailable stock",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("out_of_stock"),isBaseline:true,now:100}),null));

test("already-live persisted offer without an active Manifested anchor is reconciled once",()=>{
  const signal=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:150,lifecycleHistoryLoaded:true,latestManifestedAt:null,latestVanishedAt:null}),currentOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:200}),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"reconciled_live_anchor");
  assert.equal(signal.deliverySuppressed,true);
});

test("already-live offer with an active Manifested anchor does not duplicate the lifecycle start",()=>{
  const signal=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:150,lifecycleHistoryLoaded:true,latestManifestedAt:120,latestVanishedAt:null}),currentOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:200}),now:200});
  assert.equal(signal,null);
});''',
)
