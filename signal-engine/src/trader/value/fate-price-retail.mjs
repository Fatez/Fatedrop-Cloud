import { resolveRetailerDelivery } from '../../core/delivery-policies.mjs';
import {
  DEFAULT_RETAILER_STALE_AFTER_SECONDS,
} from '../../stores/health-staleness.mjs';
import {
  freshOfferObservation,
  trustedStockObservation,
} from '../../stores/live-offer-read-store.mjs';
import { getPresentedFatePriceFromStore } from './fate-price-service.mjs';

export const FATE_PRICE_RETAIL_CONTRACT_VERSION = 1;

const BUYABLE_STOCK = new Set(['in_stock', 'low_stock']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  return value == null ? null : Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundPercent(value) {
  return value == null ? null : Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function confidenceComparable(fatePrice) {
  return fatePrice?.confidence?.level === 'medium' || fatePrice?.confidence?.level === 'high';
}

export function classifyFatePriceRetailComparison({
  deliveredAmount,
  fatePrice,
} = {}) {
  const delivered = number(deliveredAmount);
  const amount = number(fatePrice?.price?.amount);
  const fairLow = number(fatePrice?.price?.fairLow);
  const fairHigh = number(fatePrice?.price?.fairHigh);
  const currencyCode = text(fatePrice?.price?.currencyCode).toUpperCase();

  let reason = null;
  if (delivered == null) reason = 'DELIVERED_PRICE_UNKNOWN';
  else if (!fatePrice?.available || !fatePrice?.price) reason = fatePrice?.reason || 'FATE_PRICE_UNAVAILABLE';
  else if (currencyCode !== 'GBP') reason = 'COMPARISON_CURRENCY_MISMATCH';
  else if (!confidenceComparable(fatePrice)) reason = 'FATE_PRICE_CONFIDENCE_TOO_LOW';
  else if (amount == null || amount <= 0 || fairLow == null || fairHigh == null || fairLow > fairHigh) reason = 'FAIR_RANGE_UNAVAILABLE';

  if (reason) {
    return Object.freeze({
      status: 'unavailable',
      label: 'Unable to compare',
      reason,
      basis: delivered == null ? null : 'delivered',
      deliveredAmount: delivered,
      differenceAmount: null,
      differencePercent: null,
      fatePrice: null,
    });
  }

  const status = delivered < fairLow
    ? 'good_price'
    : delivered > fairHigh
      ? 'high_price'
      : 'fair_price';
  const label = status === 'good_price' ? 'Good price' : status === 'high_price' ? 'High price' : 'Fair price';
  const differenceAmount = roundMoney(delivered - amount);
  const differencePercent = amount > 0 ? roundPercent((differenceAmount / amount) * 100) : null;

  return Object.freeze({
    status,
    label,
    reason: null,
    basis: 'delivered',
    deliveredAmount: delivered,
    differenceAmount,
    differencePercent,
    fatePrice: Object.freeze({
      amount,
      fairLow,
      fairHigh,
      currencyCode,
      asOf: number(fatePrice.price.asOf),
      confidence: fatePrice.confidence.level,
    }),
  });
}

function mappingRowsFromFile(state, cardIdentityId) {
  const mappings = Object.values(state?.fatePriceRetailOfferMappings || {});
  const offers = state?.offers || {};
  const retailers = state?.retailers || {};
  return mappings
    .filter((mapping) => mapping?.cardIdentityId === cardIdentityId && mapping?.verificationStatus === 'verified')
    .map((mapping) => {
      const offer = offers[mapping.offerId];
      const retailer = offer ? retailers[offer.retailerId] : null;
      return offer ? { ...mapping, ...offer, retailerHealthy: retailer?.healthy === true, retailerStale: retailer?.stale === true } : null;
    })
    .filter(Boolean);
}

async function mappingRowsFromPostgres(store, cardIdentityId) {
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT
      m.id AS mapping_id,m.card_identity_id,m.offer_id,m.market_segment_key,m.condition_code,m.language_code,
      m.verified_at,m.evidence AS mapping_evidence,
      o.retailer_id,o.retailer_name,o.retailer_sku,o.title,o.url,o.image_url,o.price_pence,o.postage_pence,
      o.stock_status,o.stock_confidence,o.stock_quantity,o.last_seen_at,
      h.healthy AS retailer_healthy
    FROM fatedrop_card_retail_offer_mappings m
    JOIN fatedrop_retail_offers o ON o.offer_id=m.offer_id
    JOIN fatedrop_retailer_health h ON h.retailer_id=o.retailer_id
    WHERE m.card_identity_id=$1 AND m.verification_status='verified'
    ORDER BY o.last_seen_at DESC,o.retailer_name,o.offer_id`, [cardIdentityId]);
  return rows.map((row) => ({
    id: row.mapping_id,
    cardIdentityId: row.card_identity_id,
    offerId: row.offer_id,
    marketSegmentKey: row.market_segment_key,
    conditionCode: row.condition_code,
    languageCode: row.language_code,
    verifiedAt: number(row.verified_at),
    evidence: row.mapping_evidence,
    retailerId: row.retailer_id,
    retailerName: row.retailer_name,
    retailerSku: row.retailer_sku,
    title: row.title,
    url: row.url,
    imageUrl: row.image_url,
    pricePence: number(row.price_pence),
    postagePence: number(row.postage_pence),
    stockStatus: row.stock_status,
    stockConfidence: number(row.stock_confidence),
    stockQuantity: number(row.stock_quantity),
    lastSeenAt: number(row.last_seen_at),
    retailerHealthy: row.retailer_healthy === true,
    retailerStale: false,
  }));
}

async function mappingRows(store, cardIdentityId) {
  if (typeof store?.read === 'function') return mappingRowsFromFile(await store.read(), cardIdentityId);
  if (typeof store?.pool === 'function') {
    try {
      return await mappingRowsFromPostgres(store, cardIdentityId);
    } catch (error) {
      if (error?.code === '42P01') return null;
      throw error;
    }
  }
  return null;
}

function deliveryFor(row) {
  const itemPricePence = number(row.pricePence);
  if (itemPricePence == null || itemPricePence < 0) {
    return Object.freeze({ known: false, postagePence: null, deliveredPricePence: null, source: null });
  }
  const storedPostage = number(row.postagePence);
  if (storedPostage != null && storedPostage >= 0) {
    return Object.freeze({
      known: true,
      postagePence: storedPostage,
      deliveredPricePence: itemPricePence + storedPostage,
      source: 'retailer_offer',
    });
  }
  const policy = resolveRetailerDelivery({ retailerId: row.retailerId, subtotalPence: itemPricePence });
  return Object.freeze({
    known: policy.known,
    postagePence: policy.postagePence,
    deliveredPricePence: policy.known ? itemPricePence + policy.postagePence : null,
    source: policy.known ? 'verified_delivery_policy' : null,
    policyVerifiedAt: policy.verifiedAt || null,
  });
}

function scopeKey(row) {
  return `${text(row.marketSegmentKey)}|${text(row.conditionCode)}`;
}

export async function getFatePriceRetailOffersFromStore(store, {
  cardIdentityId,
  now = Date.now(),
  fxClient,
} = {}) {
  const id = text(cardIdentityId);
  if (!id) throw new TypeError('cardIdentityId is required');
  const rows = await mappingRows(store, id);
  if (rows == null) {
    return Object.freeze({
      contractVersion: FATE_PRICE_RETAIL_CONTRACT_VERSION,
      cardIdentityId: id,
      status: 'unavailable',
      reason: 'retail_card_offer_schema_missing',
      offers: Object.freeze([]),
    });
  }

  const currentSeconds = Math.floor(Number(now) / 1000);
  const liveRows = rows.filter((row) => (
    row.retailerHealthy === true
    && row.retailerStale !== true
    && BUYABLE_STOCK.has(text(row.stockStatus).toLowerCase())
    && freshOfferObservation(row, { now: currentSeconds, staleAfterSeconds: DEFAULT_RETAILER_STALE_AFTER_SECONDS })
    && trustedStockObservation(row)
  ));

  const priceByScope = new Map();
  for (const row of liveRows) {
    const key = scopeKey(row);
    if (priceByScope.has(key)) continue;
    priceByScope.set(key, await getPresentedFatePriceFromStore(store, {
      cardIdentityId: id,
      displayCurrencyCode: 'GBP',
      marketSegmentKey: text(row.marketSegmentKey) || null,
      conditionCode: text(row.conditionCode) || null,
      now,
      fxClient,
    }));
  }

  const offers = liveRows.map((row) => {
    const delivery = deliveryFor(row);
    const comparison = classifyFatePriceRetailComparison({
      deliveredAmount: delivery.deliveredPricePence == null ? null : delivery.deliveredPricePence / 100,
      fatePrice: priceByScope.get(scopeKey(row)),
    });
    return Object.freeze({
      offerId: row.offerId,
      retailerId: row.retailerId,
      retailerName: row.retailerName,
      retailerSku: row.retailerSku,
      title: row.title,
      url: row.url,
      imageUrl: row.imageUrl || null,
      currencyCode: 'GBP',
      itemPrice: number(row.pricePence) == null ? null : roundMoney(number(row.pricePence) / 100),
      postage: delivery.postagePence == null ? null : roundMoney(delivery.postagePence / 100),
      deliveredPrice: delivery.deliveredPricePence == null ? null : roundMoney(delivery.deliveredPricePence / 100),
      deliveryKnown: delivery.known,
      deliverySource: delivery.source,
      conditionCode: text(row.conditionCode) || null,
      marketSegmentKey: text(row.marketSegmentKey) || null,
      languageCode: text(row.languageCode) || null,
      stockStatus: text(row.stockStatus),
      stockConfidence: number(row.stockConfidence),
      stockQuantity: number(row.stockQuantity),
      lastVerifiedAt: number(row.lastSeenAt) == null ? null : number(row.lastSeenAt) * 1000,
      exactIdentityVerifiedAt: number(row.verifiedAt),
      comparison,
    });
  }).sort((left, right) => {
    if (left.deliveredPrice == null && right.deliveredPrice != null) return 1;
    if (left.deliveredPrice != null && right.deliveredPrice == null) return -1;
    return (left.deliveredPrice ?? Number.POSITIVE_INFINITY) - (right.deliveredPrice ?? Number.POSITIVE_INFINITY)
      || String(left.retailerName).localeCompare(String(right.retailerName));
  });

  return Object.freeze({
    contractVersion: FATE_PRICE_RETAIL_CONTRACT_VERSION,
    cardIdentityId: id,
    status: offers.length ? 'available' : 'empty',
    reason: offers.length ? null : 'no_verified_live_retail_offers',
    offers: Object.freeze(offers),
  });
}

