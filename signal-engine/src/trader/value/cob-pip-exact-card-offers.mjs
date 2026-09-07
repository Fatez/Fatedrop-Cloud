import { getVerifiedCardSetFromStore, listVerifiedCardsFromStore } from '../catalogue/store.mjs';
import { COB_PIP_SINGLE_COLLECTIONS, collectCobPipSinglesPilot } from './cob-pip-singles-pilot.mjs';
import { buildVerifiedRetailSingleRecords, resolveRetailSingleBatch } from './retail-single-offers.mjs';
import { persistVerifiedRetailSingleRecords } from './retail-single-offer-store.mjs';

const RETAILER = Object.freeze({ id: 'cob-pip', name: 'Cob & Pip' });

function selectedBindings(collectionKeys) {
  const keys = Array.isArray(collectionKeys) && collectionKeys.length
    ? [...new Set(collectionKeys)]
    : Object.keys(COB_PIP_SINGLE_COLLECTIONS);
  return keys.map((key) => {
    const binding = COB_PIP_SINGLE_COLLECTIONS[key];
    if (!binding) throw new TypeError(`Unsupported Cob & Pip collection key: ${key}`);
    return binding;
  });
}

function assertCanonicalSet(binding, set) {
  if (!set || set.verificationStatus !== 'verified') throw new Error(`Canonical set is unavailable for ${binding.key}`);
  if (set.id !== binding.canonicalSetId
      || String(set.tcgCode || '').toLowerCase() !== binding.tcgCode
      || String(set.name || '').trim() !== binding.canonicalSetName) {
    throw new Error(`Reviewed set binding no longer matches canonical catalogue for ${binding.key}`);
  }
}

export async function runCobPipExactCardOfferCycle({
  store,
  collectionKeys = null,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  write = false,
} = {}) {
  if (!store) throw new TypeError('store is required');
  const bindings = selectedBindings(collectionKeys);
  const results = [];
  const allRecords = [];
  let pagesScanned = 0;
  let productsSeen = 0;

  for (const binding of bindings) {
    const [set, canonicalCards, discovery] = await Promise.all([
      getVerifiedCardSetFromStore(store, binding.canonicalSetId),
      listVerifiedCardsFromStore(store, { setId: binding.canonicalSetId, limit: 500 }),
      collectCobPipSinglesPilot({ collection: binding, fetchImpl, observedAt: now }),
    ]);
    assertCanonicalSet(binding, set);
    const resolution = resolveRetailSingleBatch(discovery.candidates, { binding, canonicalCards });
    const records = resolution.verified.map((item) => buildVerifiedRetailSingleRecords(item, { now }));
    allRecords.push(...records);
    pagesScanned += discovery.pages.length;
    productsSeen += discovery.pages.reduce((sum, page) => sum + page.productCount, 0);
    results.push(Object.freeze({
      collectionKey: binding.key,
      canonicalSetId: binding.canonicalSetId,
      canonicalSetName: binding.canonicalSetName,
      canonicalCards: canonicalCards.length,
      productsSeen: discovery.pages.reduce((sum, page) => sum + page.productCount, 0),
      ...resolution.counts,
      quarantineReasons: Object.freeze(Object.fromEntries(
        [...new Set(resolution.quarantined.map((item) => item.reason))]
          .sort()
          .map((reason) => [reason, resolution.quarantined.filter((item) => item.reason === reason).length]),
      )),
      quarantined: Object.freeze(resolution.quarantined.map((item) => Object.freeze({
        reason: item.reason,
        retailerVariantId: item.candidate.retailerVariantId,
        title: item.candidate.productTitle,
        variantTitle: item.candidate.variantTitle,
      }))),
    }));
  }

  const persistence = write
    ? await persistVerifiedRetailSingleRecords(store, {
      retailer: RETAILER,
      records: allRecords,
      observedAt: Math.floor(Number(now) / 1000),
      pagesScanned,
      productsSeen,
    })
    : null;
  return Object.freeze({
    mode: write ? 'write' : 'dry-run',
    retailer: RETAILER,
    generatedAt: new Date(now).toISOString(),
    collectionCount: results.length,
    productsSeen,
    candidates: results.reduce((sum, item) => sum + item.candidates, 0),
    verified: results.reduce((sum, item) => sum + item.verified, 0),
    buyableVerified: results.reduce((sum, item) => sum + item.buyableVerified, 0),
    quarantined: results.reduce((sum, item) => sum + item.quarantined.length, 0),
    collections: Object.freeze(results),
    persistence,
  });
}

export const __test = Object.freeze({ assertCanonicalSet, selectedBindings });
