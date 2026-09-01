import { scanRetailerSource } from '../../adapters/index.mjs';
import { effectivePurchasable } from '../../core/preparation-intelligence.mjs';
import { stableId } from '../../core/normalize.mjs';
import { classifyOnePieceSealedOffer } from './sealed-product-intelligence.mjs';
import { onePieceShadowRetailers } from './shadow-retailers.mjs';

function baselineKey(retailerId, product) {
  return `${retailerId}|${product.retailerSku}`;
}

function normalizedBaseline(previousBaseline) {
  const offers = Array.isArray(previousBaseline?.offers) ? previousBaseline.offers : [];
  return new Map(offers.map((offer) => [baselineKey(offer.retailerId, offer), offer]));
}

function normalizedRetailerStates(previousBaseline) {
  const states = new Map();
  for (const state of Array.isArray(previousBaseline?.retailerStates) ? previousBaseline.retailerStates : []) {
    if (state?.retailerId) states.set(state.retailerId, state.baselineEstablished === true);
  }

  // Backwards compatibility for a baseline produced before per-retailer state
  // was recorded. An existing offer proves that retailer already established a
  // silent baseline; an empty legacy baseline does not.
  for (const offer of Array.isArray(previousBaseline?.offers) ? previousBaseline.offers : []) {
    if (offer?.retailerId && !states.has(offer.retailerId)) states.set(offer.retailerId, true);
  }
  return states;
}

function shadowEpisode({ retailer, previous, current, classification, observedAt }) {
  if (!previous) {
    return Object.freeze({
      id: stableId('fdopshadowepisode', retailer.id, current.retailerSku, 'catalogue_added', String(observedAt)),
      kind: 'catalogue_added',
      retailerId: retailer.id,
      retailerSku: current.retailerSku,
      identityKey: classification.identityKey,
      previousStockStatus: null,
      currentStockStatus: current.stockStatus,
      observedAt,
      observationOnly: true,
    });
  }

  const wasPurchasable = effectivePurchasable(previous);
  const nowPurchasable = effectivePurchasable(current);
  let kind = null;
  if (!wasPurchasable && nowPurchasable) kind = 'availability_observed';
  else if (wasPurchasable && !nowPurchasable) kind = 'availability_lost';
  else if (previous.pricePence !== current.pricePence) kind = 'price_changed';
  else if (previous.stockStatus !== current.stockStatus) kind = 'stock_evidence_changed';
  if (!kind) return null;

  return Object.freeze({
    id: stableId('fdopshadowepisode', retailer.id, current.retailerSku, kind, String(observedAt)),
    kind,
    retailerId: retailer.id,
    retailerSku: current.retailerSku,
    identityKey: classification.identityKey,
    previousStockStatus: previous.stockStatus,
    currentStockStatus: current.stockStatus,
    previousPricePence: previous.pricePence ?? null,
    currentPricePence: current.pricePence ?? null,
    observedAt,
    observationOnly: true,
  });
}

export function buildOnePieceShadowReport({ retailerRuns = [], previousBaseline = null, observedAt = Math.floor(Date.now() / 1000) } = {}) {
  const previous = normalizedBaseline(previousBaseline);
  const previousRetailerStates = normalizedRetailerStates(previousBaseline);
  const firstBaseline = previousBaseline == null;
  const reportRetailers = [];
  const offers = [];
  const nextBaselineOffers = new Map(previous);
  const nextRetailerStates = new Map(previousRetailerStates);
  const episodes = [];
  const silentBaselineRetailers = [];
  const totals = { retailers: 0, healthy: 0, offersSeen: 0, matched: 0, unresolved: 0, conflicting: 0, rejected: 0, stale: 0, episodes: 0 };

  for (const run of retailerRuns) {
    const retailer = run.retailer;
    totals.retailers += 1;
    if (run.error) {
      reportRetailers.push(Object.freeze({
        retailerId: retailer.id,
        retailerName: retailer.name,
        healthy: false,
        complete: false,
        offersSeen: 0,
        matched: 0,
        unresolved: 0,
        conflicting: 0,
        rejected: 0,
        stale: 0,
        error: String(run.error?.message || run.error),
      }));
      continue;
    }

    const retailerBaselineEstablished = previousRetailerStates.get(retailer.id) === true;
    if (!retailerBaselineEstablished) silentBaselineRetailers.push(retailer.id);
    nextRetailerStates.set(retailer.id, true);
    const products = Array.isArray(run.result?.products) ? run.result.products : [];
    const currentKeys = new Set();
    const counts = { matched: 0, unresolved: 0, conflicting: 0, rejected: 0, stale: 0 };
    for (const product of products) {
      const classification = classifyOnePieceSealedOffer(product, { retailerId: retailer.id });
      counts[classification.status] += 1;
      totals[classification.status] += 1;
      totals.offersSeen += 1;
      const normalized = Object.freeze({
        retailerId: retailer.id,
        retailerName: retailer.name,
        retailerSku: product.retailerSku,
        title: product.title,
        url: product.url,
        pricePence: product.pricePence ?? null,
        stockStatus: product.stockStatus,
        stockConfidence: product.stockConfidence,
        identityStatus: classification.status,
        identity: classification.identity,
        identityKey: classification.identityKey,
        unresolvedReasons: classification.reasons,
        observedAt,
      });
      offers.push(normalized);
      const key = baselineKey(retailer.id, normalized);
      currentKeys.add(key);
      nextBaselineOffers.set(key, normalized);
      if (retailerBaselineEstablished && classification.status === 'matched') {
        const episode = shadowEpisode({
          retailer,
          previous: previous.get(key),
          current: normalized,
          classification,
          observedAt,
        });
        if (episode) episodes.push(episode);
      }
    }

    if (retailerBaselineEstablished && run.result?.complete === true) {
      for (const [key, oldOffer] of previous.entries()) {
        if (oldOffer.retailerId !== retailer.id || currentKeys.has(key)) continue;
        counts.stale += 1;
        totals.stale += 1;
        nextBaselineOffers.delete(key);
      }
    }

    totals.healthy += 1;
    reportRetailers.push(Object.freeze({
      retailerId: retailer.id,
      retailerName: retailer.name,
      healthy: true,
      complete: run.result?.complete === true,
      offersSeen: products.length,
      ...counts,
      error: null,
    }));
  }

  totals.episodes = episodes.length;
  const baselineOffers = [...nextBaselineOffers.values()];
  const baselineRetailerStates = [...nextRetailerStates.entries()].map(([retailerId, baselineEstablished]) => Object.freeze({
    retailerId,
    baselineEstablished,
  }));
  return Object.freeze({
    contractVersion: 1,
    tcgCode: 'one-piece',
    mode: 'observation_only',
    observedAt,
    firstBaseline,
    silentBaseline: silentBaselineRetailers.length > 0,
    silentBaselineRetailers: Object.freeze(silentBaselineRetailers),
    publicBrowseEnabled: false,
    lifecycleAlertsEnabled: false,
    totals: Object.freeze(totals),
    retailers: Object.freeze(reportRetailers),
    offers: Object.freeze(offers),
    episodes: Object.freeze(episodes),
    baseline: Object.freeze({
      tcgCode: 'one-piece',
      observedAt,
      retailerStates: Object.freeze(baselineRetailerStates),
      offers: Object.freeze(baselineOffers),
    }),
  });
}

export async function runOnePieceShadowScan({
  retailers = onePieceShadowRetailers,
  previousBaseline = null,
  observedAt = Math.floor(Date.now() / 1000),
  scanSource = scanRetailerSource,
} = {}) {
  const retailerRuns = [];
  for (const retailer of retailers) {
    try {
      const result = await scanSource(retailer, { allowUnapprovedFeed: true });
      retailerRuns.push({ retailer, result });
    } catch (error) {
      retailerRuns.push({ retailer, error });
    }
  }
  return buildOnePieceShadowReport({ retailerRuns, previousBaseline, observedAt });
}
