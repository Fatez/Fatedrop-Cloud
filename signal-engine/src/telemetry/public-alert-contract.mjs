import { deriveAlertFacets, listAlertFacetOptions } from '../core/alert-facets.mjs';
import {
  effectiveSignalDeliveryPolicy,
  publicSignalSqlFilter,
  signalDeliveryPolicySql,
  signalKindFrom,
  validVanishedSqlFilter,
} from '../core/signal-visibility-policy.mjs';

export const PUBLIC_ALERT_CONTRACT_VERSION = 1;

const PUBLIC_STAGES = new Set(['whisper', 'echo', 'manifested', 'vanished']);

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function nullableText(value) {
  return typeof value === 'string' && value ? value : null;
}

function nullableNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTimestamp(value) {
  const seconds = nullableNumber(value);
  return seconds != null && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function evidenceValue(value, kind) {
  const entry = jsonArray(value).find((candidate) => candidate?.kind === kind);
  if (entry?.value == null) return null;
  const normalized = String(entry.value).trim();
  return normalized || null;
}

function presentation(row) {
  return {
    referenceKind: evidenceValue(row.evidence, 'rrp_value_kind'),
    referenceBasis: evidenceValue(row.evidence, 'rrp_reference_basis'),
    sourceMarket: evidenceValue(row.evidence, 'rrp_source_market'),
    sourceCurrency: evidenceValue(row.evidence, 'rrp_source_currency'),
    sourceMsrp: evidenceValue(row.evidence, 'rrp_source_msrp'),
  };
}

function latestDiscordDelivery(row) {
  if (!row.discord_delivery_result) return null;
  return {
    status: text(row.discord_delivery_result),
    attemptedAt: isoTimestamp(row.discord_delivery_attempted_at),
    issue: row.discord_delivery_result === 'sent' ? null : nullableText(row.discord_delivery_detail),
    providerMessageId: nullableText(row.discord_provider_message_id),
  };
}

function percentage(value, reference) {
  if (value == null || reference == null || reference <= 0) return null;
  return ((value - reference) / reference) * 100;
}

function roundOne(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

function pounds(pence) {
  return pence == null ? null : `£${(pence / 100).toFixed(2)}`;
}

function publicStage(state) {
  if (state === 'whisper') return 'WHISPER';
  if (state === 'echo') return 'ECHO';
  if (state === 'manifested') return 'MANIFESTED';
  if (state === 'vanished') return 'VANISHED';
  return 'NETWORK';
}

function stockEpisode(row) {
  const id = nullableText(row.stock_episode_id);
  if (!id) return null;
  return {
    id,
    scopeType: nullableText(row.stock_episode_scope_type),
    cycleNumber: nullableNumber(row.stock_episode_cycle_number),
    episodeState: nullableText(row.stock_episode_state),
    availabilityState: nullableText(row.stock_episode_availability_state),
    openedAt: isoTimestamp(row.stock_episode_opened_at),
    manifestedAt: isoTimestamp(row.stock_episode_manifested_at),
    vanishedAt: isoTimestamp(row.stock_episode_vanished_at),
    latestEventAt: isoTimestamp(row.stock_episode_latest_event_at),
    eventStage: nullableText(row.stock_episode_event_stage),
    eventAvailabilityEffect: nullableText(row.stock_episode_event_availability_effect),
  };
}

function availabilityTruth(row, episode) {
  const state = text(row.state).toLowerCase();
  const inferredEffect = state === 'manifested' ? 'available' : state === 'vanished' ? 'unavailable' : 'none';
  const signalEffect = episode?.eventAvailabilityEffect || inferredEffect;
  return {
    signalEffect,
    signalClaimsAvailability: signalEffect === 'available' || signalEffect === 'unavailable',
    currentEpisodeState: episode?.availabilityState || null,
    canonicalSourceStage: signalEffect === 'available' ? 'MANIFESTED' : signalEffect === 'unavailable' ? 'VANISHED' : null,
  };
}

function observedDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const secondsRemainder = whole % 60;
  if (minutes < 60) return secondsRemainder ? `${minutes}m ${secondsRemainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  if (hours < 24) return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return hourRemainder ? `${days}d ${hourRemainder}h` : `${days}d`;
}

function liveWindow(row) {
  if (row.state === 'manifested') {
    const episodeAvailable = row.stock_episode_availability_state === 'available'
      && row.stock_episode_vanished_at == null;
    if (!episodeAvailable) return null;

    const manifestedAtSeconds = nullableNumber(row.stock_episode_manifested_at);
    const lastConfirmedLiveAtSeconds = nullableNumber(row.current_live_confirmation_at);
    const manifestedSupported = manifestedAtSeconds != null && manifestedAtSeconds > 0;
    const confirmationSupported = manifestedSupported
      && lastConfirmedLiveAtSeconds != null
      && lastConfirmedLiveAtSeconds >= manifestedAtSeconds;
    const observedDurationSeconds = confirmationSupported
      ? Math.max(0, Math.floor(lastConfirmedLiveAtSeconds - manifestedAtSeconds))
      : null;

    return {
      manifestedAt: manifestedSupported ? isoTimestamp(manifestedAtSeconds) : null,
      lastConfirmedLiveAt: confirmationSupported ? isoTimestamp(lastConfirmedLiveAtSeconds) : null,
      vanishedAt: null,
      observedDurationSeconds,
      historyComplete: Boolean(manifestedSupported && confirmationSupported),
    };
  }

  if (row.state !== 'vanished') return null;

  const manifestedAtSeconds = nullableNumber(row.live_manifested_at);
  const lastConfirmedLiveAtSeconds = nullableNumber(row.last_confirmed_live_at);
  const vanishedAtSeconds = nullableNumber(row.detected_at);
  const rawDuration = nullableNumber(row.observed_duration_seconds);

  const vanishedSupported = vanishedAtSeconds != null && vanishedAtSeconds > 0;
  const manifestedSupported = vanishedSupported
    && manifestedAtSeconds != null
    && manifestedAtSeconds > 0
    && manifestedAtSeconds < vanishedAtSeconds;
  const lastConfirmedSupported = vanishedSupported
    && lastConfirmedLiveAtSeconds != null
    && lastConfirmedLiveAtSeconds > 0
    && lastConfirmedLiveAtSeconds < vanishedAtSeconds
    && (!manifestedSupported || lastConfirmedLiveAtSeconds >= manifestedAtSeconds);
  const durationSupported = manifestedSupported && rawDuration != null && rawDuration >= 0;

  const manifestedAt = manifestedSupported ? isoTimestamp(manifestedAtSeconds) : null;
  const lastConfirmedLiveAt = lastConfirmedSupported ? isoTimestamp(lastConfirmedLiveAtSeconds) : null;
  const vanishedAt = vanishedSupported ? isoTimestamp(vanishedAtSeconds) : null;
  const observedDurationSeconds = durationSupported ? Math.floor(rawDuration) : null;

  return {
    manifestedAt,
    lastConfirmedLiveAt,
    vanishedAt,
    observedDurationSeconds,
    historyComplete: Boolean(manifestedAt && lastConfirmedLiveAt && vanishedAt && observedDurationSeconds != null),
  };
}

function classifyProduct(row) {
  const persisted = jsonArray(row.evidence).find((entry) => entry?.kind === 'product_alert_classification');
  const known = new Set(['SEALED_TCG', 'SINGLE_CARD', 'ACCESSORY', 'MERCHANDISE', 'UNKNOWN']);
  if (persisted && typeof persisted.category === 'string' && known.has(persisted.category)) {
    return {
      category: persisted.category,
      subcategory: typeof persisted.subcategory === 'string' && persisted.subcategory ? persisted.subcategory : 'UNCLASSIFIED',
      confidence: Math.max(0, Math.min(1, nullableNumber(persisted.confidence) ?? 0.5)),
      evidence: Array.isArray(persisted.evidence)
        ? persisted.evidence.filter((item) => typeof item === 'string')
        : ['persisted-signal-classification'],
    };
  }

  const title = text(row.title).toLowerCase().replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
  const productType = text(row.product_type).toLowerCase().replace(/\s+/g, '_');
  const accessory = /sleeves?|binder|portfolio|deck box|play ?mat|top ?loader|card protector|dice|counter|token|storage box|card stand/.test(title);
  const merchandise = /\bpin\b|pin badge|plush|soft toy|figure|figurine|statue|hoodie|t-?shirt|shirt|jersey|clothing|apparel|\bcap\b|\bhat\b|mug|bottle|tumbler|key ?ring|keychain|lanyard|poster|print/.test(title);
  const sealed = /elite trainer box|\betb\b|booster (?:box|display|bundle|pack)|sleeved booster|blister|build\s*(?:&|and)\s*battle|trainer toolkit|battle deck|theme deck|league battle deck|starter deck|\btin\b/.test(title)
    || ['elite_trainer_box', 'booster_box', 'booster_bundle', 'booster_pack', 'tin', 'deck', 'collection_box'].includes(productType);
  const single = /\bsingle card\b|\bindividual card\b|\bpromo card\b|reverse holo|holo rare|illustration rare|special illustration rare|secret rare|full art card/.test(title)
    || ['single_card', 'card_single', 'single'].includes(productType);

  if (sealed && !accessory && !merchandise) return { category: 'SEALED_TCG', subcategory: productType || 'SEALED_PRODUCT', confidence: 0.94, evidence: ['cloud-title-product-type-classification'] };
  if (merchandise) return { category: 'MERCHANDISE', subcategory: 'MERCHANDISE', confidence: 0.94, evidence: ['cloud-title-classification'] };
  if (accessory || productType === 'accessory') return { category: 'ACCESSORY', subcategory: 'ACCESSORY', confidence: 0.94, evidence: ['cloud-title-product-type-classification'] };
  if (single) return { category: 'SINGLE_CARD', subcategory: 'SINGLE', confidence: 0.9, evidence: ['cloud-title-product-type-classification'] };
  return { category: 'UNKNOWN', subcategory: 'UNCLASSIFIED', confidence: 0.4, evidence: ['no-reliable-product-classification'] };
}

function offerLink({ offerId, retailerId, retailer, url, itemPricePence, deliveredPricePence, stockStatus }) {
  if (!offerId || !retailerId || !retailer || !url) return null;
  return { offerId, retailerId, retailer, url, itemPricePence, deliveredPricePence, stockStatus };
}

function intelligence(row) {
  const rrpPence = row.signal_rrp_pence ?? row.canonical_rrp_pence;
  const rrpDeltaPercent = roundOne(percentage(row.price_pence, rrpPence));
  const comparisonBasis = row.delivered_price_pence != null ? 'delivered' : 'item';
  const currentComparisonPence = comparisonBasis === 'delivered' ? row.delivered_price_pence : row.price_pence;
  const lowestComparisonPence = comparisonBasis === 'delivered' ? row.lowest_delivered_price_pence : row.lowest_item_price_pence;
  const comparable = currentComparisonPence != null && lowestComparisonPence != null;
  const savingsPence = comparable ? Math.max(0, currentComparisonPence - lowestComparisonPence) : null;
  const savingsPercent = comparable && currentComparisonPence > 0 ? roundOne((savingsPence / currentComparisonPence) * 100) : null;
  let verdict = 'NO_FAIR_COMPARISON';
  if (comparable) verdict = currentComparisonPence <= lowestComparisonPence ? 'LOWEST_KNOWN' : 'BETTER_OFFER_FOUND';
  return {
    rrpPence,
    rrpDeltaPercent,
    comparisonBasis,
    verdict,
    currentComparisonPence,
    lowestKnown: row.lowest_offer_id ? {
      offerId: row.lowest_offer_id,
      retailerId: row.lowest_retailer_id,
      retailer: row.lowest_retailer_name,
      url: row.lowest_url,
      itemPricePence: row.lowest_item_price_pence,
      deliveredPricePence: row.lowest_delivered_price_pence,
      comparisonPricePence: lowestComparisonPence,
      stockStatus: row.lowest_stock_status,
    } : null,
    savingsPence,
    savingsPercent,
  };
}

function signalThread(row) {
  return jsonArray(row.history_json).flatMap((entry) => {
    const id = text(entry.id);
    const state = text(entry.state);
    const retailer = text(entry.retailer);
    const url = text(entry.url);
    const detectedAt = nullableNumber(entry.detectedAt);
    if (!id || !state || !retailer || !url || detectedAt == null) return [];
    return [{
      id,
      state,
      fateStage: publicStage(state),
      retailer,
      occurredAt: new Date(detectedAt * 1000).toISOString(),
      reason: text(entry.reason),
      pricePence: nullableNumber(entry.pricePence),
      stockStatus: nullableText(entry.stockStatus),
      previousStockStatus: nullableText(entry.previousStockStatus),
      url,
    }];
  });
}

function preparedLinks(row, stage) {
  const primary = {
    offerId: row.offer_id,
    retailerId: row.retailer_id,
    retailer: row.retailer_name,
    url: row.url,
    itemPricePence: row.price_pence,
    deliveredPricePence: row.delivered_price_pence,
    stockStatus: row.stock_status,
    intent: stage === 'MANIFESTED' ? 'buy' : 'inspect',
    label: stage === 'MANIFESTED' ? 'BUY / VIEW PRODUCT' : stage === 'VANISHED' ? 'VIEW LAST PRODUCT PAGE' : 'INSPECT PRODUCT',
  };
  const lowestKnown = offerLink({
    offerId: row.lowest_offer_id,
    retailerId: row.lowest_retailer_id,
    retailer: row.lowest_retailer_name,
    url: row.lowest_url,
    itemPricePence: row.lowest_item_price_pence,
    deliveredPricePence: row.lowest_delivered_price_pence,
    stockStatus: row.lowest_stock_status,
  });
  const officialReference = offerLink({
    offerId: row.official_offer_id,
    retailerId: row.official_retailer_id,
    retailer: row.official_retailer_name,
    url: row.official_url,
    itemPricePence: row.official_item_price_pence,
    deliveredPricePence: row.official_delivered_price_pence,
    stockStatus: row.official_stock_status,
  });
  const alternatives = jsonArray(row.alternatives_json).flatMap((entry) => {
    const link = offerLink({
      offerId: nullableText(entry.offerId),
      retailerId: nullableText(entry.retailerId),
      retailer: nullableText(entry.retailer),
      url: nullableText(entry.url),
      itemPricePence: nullableNumber(entry.itemPricePence),
      deliveredPricePence: nullableNumber(entry.deliveredPricePence),
      stockStatus: nullableText(entry.stockStatus),
    });
    return link ? [link] : [];
  });
  return { primary, lowestKnown, officialReference, alternatives, compareQuery: row.title, fateFindQuery: row.title };
}

function notificationCopy(row, priceIntelligence, links, productIntelligence) {
  const stage = publicStage(row.state);
  const stageLabel = stage === 'WHISPER' ? 'Whisper' : stage === 'ECHO' ? 'Echo' : stage === 'MANIFESTED' ? 'Manifested' : stage === 'VANISHED' ? 'Vanished' : 'Signal';
  const price = pounds(row.price_pence);
  const rrp = pounds(priceIntelligence.rrpPence);
  const delta = priceIntelligence.rrpDeltaPercent;
  const lines = [price ? `${row.retailer_name} · ${price}` : row.retailer_name];
  if (stage === 'WHISPER') lines.push('Catalogue or product movement detected · stock is not confirmed');
  if (stage === 'ECHO') lines.push('Queue, traffic or security readiness changed · get ready · stock is not confirmed');
  if (stage === 'VANISHED') {
    lines.push('Observed availability is no longer verified');
    const duration = observedDuration(row.observed_duration_seconds);
    if (duration) lines.push(`Observed live for ${duration}`);
  }
  if (rrp && delta != null) {
    const direction = delta === 0 ? 'at RRP' : delta > 0 ? `${delta.toFixed(1)}% over RRP` : `${Math.abs(delta).toFixed(1)}% below RRP`;
    lines.push(`${direction} · RRP ${rrp}`);
  }
  if (priceIntelligence.verdict === 'BETTER_OFFER_FOUND' && priceIntelligence.lowestKnown?.comparisonPricePence != null) {
    const lowest = pounds(priceIntelligence.lowestKnown.comparisonPricePence);
    const saving = pounds(priceIntelligence.savingsPence);
    const basis = priceIntelligence.comparisonBasis === 'delivered' ? 'delivered' : 'item price';
    lines.push(`Better offer: ${lowest} at ${priceIntelligence.lowestKnown.retailer}${saving ? ` · save ${saving}` : ''} · ${basis}`);
  } else if (priceIntelligence.verdict === 'LOWEST_KNOWN') {
    lines.push('FateDrop verdict: lowest known comparable offer');
  } else if (stage === 'VANISHED' && links.alternatives.length) {
    lines.push(`${links.alternatives.length} live alternative${links.alternatives.length === 1 ? '' : 's'} prepared`);
  } else {
    lines.push('FateDrop verdict: no fair price comparison yet');
  }
  return {
    title: `FateDrop · ${stageLabel} · ${row.title}`,
    body: lines.join('\n'),
    data: {
      route: 'alerts',
      alertId: row.id,
      tcgCode: nullableText(row.tcg_code) || 'unknown',
      productUrl: row.url,
      stage,
      verdict: priceIntelligence.verdict,
      lowestKnownUrl: links.lowestKnown?.url ?? null,
      compareQuery: links.compareQuery,
      productCategory: productIntelligence.category,
      signalKind: signalKindFrom(row) || null,
      languageGroup: row.alert_facets?.languageGroup || null,
      setKey: row.alert_facets?.setKey || null,
      observedDurationSeconds: row.observed_duration_seconds,
      linksPrepared: true,
    },
  };
}

function toCanonicalAlert(row) {
  const fateStage = publicStage(row.state);
  const priceIntelligence = intelligence(row);
  const links = preparedLinks(row, fateStage);
  const productIntelligence = classifyProduct(row);
  const window = liveWindow(row);
  const facets = deriveAlertFacets({ title: row.title, retailerCountryCode: 'GB', evidence: row.evidence });
  const deliveryPolicy = row.delivery_policy || effectiveSignalDeliveryPolicy(row);
  const episode = stockEpisode(row);
  row.alert_facets = facets;
  return {
    id: row.id,
    tcgCode: nullableText(row.tcg_code) || 'unknown',
    type: row.state.toUpperCase(),
    fateStage,
    productId: row.product_id,
    offerId: row.offer_id,
    retailerId: row.retailer_id,
    title: row.title,
    message: row.reason,
    signalKind: signalKindFrom(row) || null,
    deliveryPolicy,
    interruptEligible: deliveryPolicy === 'interrupt',
    facets,
    retailer: row.retailer_name,
    detectedAt: isoTimestamp(row.detected_at),
    observedDurationSeconds: window?.observedDurationSeconds ?? null,
    liveWindow: window,
    stockEpisode: episode,
    availabilityTruth: availabilityTruth(row, episode),
    productIntelligence,
    confirmed: fateStage === 'MANIFESTED',
    confirmedRestock: fateStage === 'MANIFESTED',
    productUrl: row.url,
    product: {
      tcgCode: nullableText(row.tcg_code) || 'unknown',
      title: row.title,
      productType: row.product_type,
      url: row.url,
      imageUrl: row.image_url,
      pricePence: row.price_pence,
      rrpPence: priceIntelligence.rrpPence,
      deliveredPricePence: row.delivered_price_pence,
      stockStatus: row.stock_status,
    },
    presentation: presentation(row),
    delivery: { discord: latestDiscordDelivery(row) },
    priceIntelligence,
    signalThread: signalThread(row),
    preparedLinks: links,
    notification: notificationCopy(row, priceIntelligence, links, productIntelligence),
    confidence: Number(row.confidence),
  };
}

const ALERT_SQL = `
  SELECT
    s.id,s.state,s.product_id,s.offer_id,s.retailer_id,s.retailer_name,s.title,s.product_type,s.url,s.image_url,s.price_pence,
    s.rrp_pence AS signal_rrp_pence,p.official_rrp_pence AS canonical_rrp_pence,p.tcg AS tcg_code,
    s.delivered_price_pence,s.postage_pence,s.stock_status,s.previous_stock_status,s.confidence,s.detected_at,
    canonical_episode.id AS stock_episode_id,canonical_episode.scope_type AS stock_episode_scope_type,
    canonical_episode.cycle_number AS stock_episode_cycle_number,canonical_episode.episode_state AS stock_episode_state,
    canonical_episode.availability_state AS stock_episode_availability_state,canonical_episode.opened_at AS stock_episode_opened_at,
    canonical_episode.manifested_at AS stock_episode_manifested_at,canonical_episode.vanished_at AS stock_episode_vanished_at,
    canonical_episode.latest_event_at AS stock_episode_latest_event_at,canonical_event.stage AS stock_episode_event_stage,
    canonical_event.availability_effect AS stock_episode_event_availability_effect,
    ${signalDeliveryPolicySql('s')} AS delivery_policy,
    live_window.manifested_at AS live_manifested_at,
    persisted_live.last_confirmed_live_at,
    current_live.last_confirmed_live_at AS current_live_confirmation_at,
    (CASE WHEN s.state='vanished' AND live_window.manifested_at IS NOT NULL THEN GREATEST(0,s.detected_at-live_window.manifested_at) ELSE NULL END)::integer AS observed_duration_seconds,
    s.reason,s.evidence,
    best.offer_id AS lowest_offer_id,best.retailer_id AS lowest_retailer_id,best.retailer_name AS lowest_retailer_name,best.url AS lowest_url,
    best.price_pence AS lowest_item_price_pence,best.stock_status AS lowest_stock_status,
    CASE WHEN best.postage_pence IS NOT NULL AND best.price_pence IS NOT NULL THEN best.price_pence + best.postage_pence ELSE NULL END AS lowest_delivered_price_pence,
    official.offer_id AS official_offer_id,official.retailer_id AS official_retailer_id,official.retailer_name AS official_retailer_name,official.url AS official_url,
    official.price_pence AS official_item_price_pence,official.stock_status AS official_stock_status,
    CASE WHEN official.postage_pence IS NOT NULL AND official.price_pence IS NOT NULL THEN official.price_pence + official.postage_pence ELSE NULL END AS official_delivered_price_pence,
    history.history_json,alternatives.alternatives_json,
    discord_delivery.result AS discord_delivery_result,discord_delivery.detail AS discord_delivery_detail,
    discord_delivery.provider_message_id AS discord_provider_message_id,discord_delivery.attempted_at AS discord_delivery_attempted_at
  FROM fatedrop_signals s
  LEFT JOIN fatedrop_products p ON p.id=s.product_id
  LEFT JOIN fatedrop_stock_episode_events canonical_event ON canonical_event.signal_id=s.id
  LEFT JOIN fatedrop_stock_episodes canonical_episode ON canonical_episode.id=canonical_event.episode_id
  LEFT JOIN LATERAL (
    SELECT ro.offer_id,ro.retailer_id,ro.retailer_name,ro.url,ro.price_pence,ro.postage_pence,ro.stock_status
    FROM fatedrop_retail_offers ro
    JOIN fatedrop_retailer_health rh ON rh.retailer_id=ro.retailer_id
      AND rh.healthy=true
      AND COALESCE(rh.last_success_at,rh.last_scan_at) >= EXTRACT(EPOCH FROM NOW())::bigint - 1800
    WHERE ro.product_id=s.product_id
      AND ro.stock_status IN ('in_stock','low_stock','preorder')
      AND ro.price_pence IS NOT NULL
      AND (s.delivered_price_pence IS NULL OR ro.postage_pence IS NOT NULL)
    ORDER BY CASE WHEN s.delivered_price_pence IS NOT NULL THEN ro.price_pence + ro.postage_pence ELSE ro.price_pence END ASC, ro.last_seen_at DESC
    LIMIT 1
  ) best ON true
  LEFT JOIN LATERAL (
    SELECT ro.offer_id,ro.retailer_id,ro.retailer_name,ro.url,ro.price_pence,ro.postage_pence,ro.stock_status
    FROM fatedrop_retail_offers ro
    JOIN fatedrop_retailer_health rh ON rh.retailer_id=ro.retailer_id
      AND rh.healthy=true
      AND COALESCE(rh.last_success_at,rh.last_scan_at) >= EXTRACT(EPOCH FROM NOW())::bigint - 1800
    WHERE ro.product_id=s.product_id AND ro.retailer_id='pokemon-center-uk'
    ORDER BY ro.last_seen_at DESC
    LIMIT 1
  ) official ON true
  LEFT JOIN LATERAL (
    SELECT hs.detected_at AS manifested_at
    FROM fatedrop_signals hs
    WHERE s.state='vanished'
      AND hs.offer_id=s.offer_id
      AND hs.state='manifested'
      AND hs.detected_at < s.detected_at
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_signals hv
        WHERE hv.offer_id=s.offer_id
          AND hv.state='vanished'
          AND hv.detected_at > hs.detected_at
          AND hv.detected_at < s.detected_at
      )
    ORDER BY hs.detected_at DESC
    LIMIT 1
  ) live_window ON true
  LEFT JOIN LATERAL (
    SELECT
      true AS persisted_prior_live,
      (evidence_item->>'observedAt')::bigint AS last_confirmed_live_at
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.evidence)='array' THEN s.evidence ELSE '[]'::jsonb END) evidence_item
    WHERE s.state='vanished'
      AND evidence_item->>'kind'='prior_live_confirmation'
      AND evidence_item->>'value'='persisted_purchasable_offer'
      AND COALESCE(evidence_item->>'observedAt','') ~ '^[0-9]+$'
      AND (evidence_item->>'observedAt')::bigint > 0
      AND (evidence_item->>'observedAt')::bigint < s.detected_at
    ORDER BY (evidence_item->>'observedAt')::bigint DESC
    LIMIT 1
  ) persisted_live ON true
  LEFT JOIN LATERAL (
    SELECT ro.last_seen_at AS last_confirmed_live_at
    FROM fatedrop_retail_offers ro
    JOIN fatedrop_retailer_health rh ON rh.retailer_id=ro.retailer_id
      AND rh.healthy=true
      AND COALESCE(rh.last_success_at,rh.last_scan_at) >= EXTRACT(EPOCH FROM NOW())::bigint - 1800
    WHERE s.state='manifested'
      AND canonical_episode.availability_state='available'
      AND canonical_episode.vanished_at IS NULL
      AND ro.offer_id=s.offer_id
      AND ro.stock_status IN ('in_stock','low_stock','preorder')
      AND ro.last_seen_at >= EXTRACT(EPOCH FROM NOW())::bigint - 1800
    LIMIT 1
  ) current_live ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',h.id,'state',h.state,'retailer',h.retailer_name,'detectedAt',h.detected_at,'reason',h.reason,
      'pricePence',h.price_pence,'stockStatus',h.stock_status,'previousStockStatus',h.previous_stock_status,'url',h.url
    ) ORDER BY h.detected_at ASC),'[]'::jsonb) AS history_json
    FROM (
      SELECT hs.id,hs.state,hs.retailer_name,hs.detected_at,hs.reason,hs.price_pence,hs.stock_status,hs.previous_stock_status,hs.url
      FROM fatedrop_signals hs
      LEFT JOIN fatedrop_stock_episode_events history_event ON history_event.signal_id=hs.id
      WHERE hs.offer_id=s.offer_id
        AND (canonical_event.episode_id IS NULL OR history_event.episode_id=canonical_event.episode_id)
      ORDER BY hs.detected_at DESC
      LIMIT 12
    ) h
  ) history ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'offerId',a.offer_id,'retailerId',a.retailer_id,'retailer',a.retailer_name,'url',a.url,
      'itemPricePence',a.price_pence,'deliveredPricePence',a.delivered_price_pence,'stockStatus',a.stock_status
    ) ORDER BY a.sort_price ASC,a.last_seen_at DESC),'[]'::jsonb) AS alternatives_json
    FROM (
      SELECT ro.offer_id,ro.retailer_id,ro.retailer_name,ro.url,ro.price_pence,ro.stock_status,ro.last_seen_at,
        CASE WHEN ro.postage_pence IS NOT NULL AND ro.price_pence IS NOT NULL THEN ro.price_pence + ro.postage_pence ELSE NULL END AS delivered_price_pence,
        COALESCE(CASE WHEN ro.postage_pence IS NOT NULL AND ro.price_pence IS NOT NULL THEN ro.price_pence + ro.postage_pence END,ro.price_pence) AS sort_price
      FROM fatedrop_retail_offers ro
      JOIN fatedrop_retailer_health rh ON rh.retailer_id=ro.retailer_id
        AND rh.healthy=true
        AND COALESCE(rh.last_success_at,rh.last_scan_at) >= EXTRACT(EPOCH FROM NOW())::bigint - 1800
      WHERE ro.product_id=s.product_id AND ro.offer_id<>s.offer_id
        AND ro.stock_status IN ('in_stock','low_stock','preorder') AND ro.price_pence IS NOT NULL
      ORDER BY CASE WHEN ro.postage_pence IS NULL THEN 1 ELSE 0 END ASC,
        COALESCE(CASE WHEN ro.postage_pence IS NOT NULL THEN ro.price_pence + ro.postage_pence END,ro.price_pence) ASC,
        ro.last_seen_at DESC
      LIMIT 8
    ) a
  ) alternatives ON true
  LEFT JOIN LATERAL (
    SELECT delivery.result,delivery.detail,delivery.provider_message_id,delivery.attempted_at
    FROM fatedrop_signal_delivery_attempts delivery
    WHERE delivery.signal_id=s.id AND delivery.channel='discord'
    ORDER BY delivery.attempted_at DESC
    LIMIT 1
  ) discord_delivery ON true
  WHERE ($1::text IS NULL OR s.id=$1)
    AND ($2::text[] IS NULL OR s.state=ANY($2))
    AND ($4::bigint IS NULL OR s.detected_at >= $4)
    AND ($5::bigint IS NULL OR s.detected_at < $5 OR (s.detected_at=$5 AND s.id>COALESCE($6::text,'')))
    AND ${publicSignalSqlFilter('s')}
    AND ${validVanishedSqlFilter('s')}
    AND s.state IN ('whisper','echo','manifested','vanished')
  ORDER BY s.detected_at DESC,s.id ASC
  LIMIT $3`;

export async function listCanonicalPublicAlerts(store, { id = null, state = null, states = null, since = null, before = null, beforeId = null, limit = 50 } = {}) {
  if (!store || typeof store.pool !== 'function') return null;
  const pool = await store.pool();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const normalizedState = String(state || '').trim().toLowerCase();
  const requestedStates = Array.isArray(states)
    ? [...new Set(states.map((item) => String(item || '').trim().toLowerCase()).filter((item) => PUBLIC_STAGES.has(item)))]
    : [];
  if (PUBLIC_STAGES.has(normalizedState)) requestedStates.push(normalizedState);
  const safeStates = requestedStates.length ? [...new Set(requestedStates)] : null;
  const safeSince = Number.isFinite(Number(since)) && Number(since) > 0 ? Math.trunc(Number(since)) : null;
  const safeBefore = Number.isFinite(Number(before)) && Number(before) > 0 ? Math.trunc(Number(before)) : null;
  const { rows } = await pool.query(ALERT_SQL, [id || null, safeStates, safeLimit, safeSince, safeBefore, safeBefore ? String(beforeId || '') : null]);
  return rows
    .filter((row) => PUBLIC_STAGES.has(String(row.state)))
    .map(toCanonicalAlert);
}

export async function handlePublicAlerts(req, res, { store } = {}) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  const id = url.searchParams.get('id')?.trim() || null;
  const state = url.searchParams.get('state')?.trim().toLowerCase() || null;
  const since = Math.max(0, Number.parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const before = Math.max(0, Number.parseInt(url.searchParams.get('before') || '0', 10) || 0);
  const beforeId = url.searchParams.get('beforeId')?.trim() || null;
  const alerts = await listCanonicalPublicAlerts(store, { id, state, since: since || null, before: before || null, beforeId, limit });
  if (!alerts) {
    return json(res, 200, {
      success: false,
      available: false,
      contractVersion: PUBLIC_ALERT_CONTRACT_VERSION,
      source: 'FATEDROP_CLOUD',
      generatedAt: new Date().toISOString(),
      count: 0,
      alerts: [],
    });
  }
  return json(res, 200, {
    success: true,
    available: true,
    contractVersion: PUBLIC_ALERT_CONTRACT_VERSION,
    source: 'FATEDROP_CLOUD',
    generatedAt: new Date().toISOString(),
    count: alerts.length,
    alerts,
  });
}

export async function handlePublicAlertFacets(_req, res) {
  return json(res, 200, {
    success: true,
    available: true,
    contractVersion: PUBLIC_ALERT_CONTRACT_VERSION,
    source: 'FATEDROP_CLOUD',
    generatedAt: new Date().toISOString(),
    ...listAlertFacetOptions(),
  });
}
