import {
  getVerifiedCardSetFromStore,
  listVerifiedCardsFromStore,
  listVerifiedCardSetsFromStore,
} from '../catalogue/store.mjs';
import { COB_PIP_RETAILER, COB_PIP_SINGLE_COLLECTIONS, collectCobPipSinglesPilot } from './cob-pip-singles-pilot.mjs';
import { buildVerifiedRetailSingleRecords, resolveRetailSingleBatch } from './retail-single-offers.mjs';
import { persistVerifiedRetailSingleRecords } from './retail-single-offer-store.mjs';

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

async function resolveCanonicalBinding(store, binding) {
  if (binding.canonicalSetId) {
    const set = await getVerifiedCardSetFromStore(store, binding.canonicalSetId);
    assertCanonicalSet(binding, set);
    return Object.freeze({ status: 'ready', binding, set });
  }

  // Pending retailer collections can activate without another code change once
  // the canonical catalogue contains exactly one verified set with the reviewed
  // name. This is an exact equality gate, never a similarity/title search.
  const sets = await listVerifiedCardSetsFromStore(store, { tcgCode: binding.tcgCode, limit: 1000 });
  const matches = sets.filter((set) => String(set?.name || '').trim() === binding.canonicalSetName);
  if (!matches.length) {
    return Object.freeze({ status: 'held', reason: 'canonical_set_unavailable', binding, set: null });
  }
  if (matches.length !== 1) {
    return Object.freeze({ status: 'held', reason: 'canonical_set_name_conflict', binding, set: null });
  }
  const set = matches[0];
  const resolvedBinding = Object.freeze({ ...binding, canonicalSetId: set.id });
  assertCanonicalSet(resolvedBinding, set);
  return Object.freeze({ status: 'ready', binding: resolvedBinding, set });
}

function heldResult(binding, reason) {
  return Object.freeze({
    status: 'held',
    reason,
    collectionKey: binding.key,
    canonicalSetId: binding.canonicalSetId || null,
    canonicalSetName: binding.canonicalSetName,
    canonicalCards: 0,
    productsSeen: 0,
    candidates: 0,
    verified: 0,
    buyableVerified: 0,
    quarantineReasons: Object.freeze({ [reason]: 1 }),
    quarantined: Object.freeze([]),
  });
}

function failedResult(binding, error) {
  return Object.freeze({
    status: 'failed',
    reason: 'collection_cycle_failed',
    collectionKey: binding.key,
    canonicalSetId: binding.canonicalSetId || null,
    canonicalSetName: binding.canonicalSetName,
    canonicalCards: 0,
    productsSeen: 0,
    candidates: 0,
    verified: 0,
    buyableVerified: 0,
    quarantineReasons: Object.freeze({ collection_cycle_failed: 1 }),
    quarantined: Object.freeze([]),
    error: Object.freeze({
      name: String(error?.name || 'Error'),
      message: String(error?.message || 'Cob & Pip collection cycle failed'),
    }),
  });
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

  for (const configuredBinding of bindings) {
    try {
      const canonical = await resolveCanonicalBinding(store, configuredBinding);
      if (canonical.status !== 'ready') {
        results.push(heldResult(configuredBinding, canonical.reason));
        continue;
      }
      const binding = canonical.binding;
      const [canonicalCards, discovery] = await Promise.all([
        listVerifiedCardsFromStore(store, { setId: binding.canonicalSetId, limit: 500 }),
        collectCobPipSinglesPilot({ collection: binding, fetchImpl, observedAt: now }),
      ]);
      assertCanonicalSet(binding, canonical.set);
      const resolution = resolveRetailSingleBatch(discovery.candidates, { binding, canonicalCards });
      const records = resolution.verified.map((item) => buildVerifiedRetailSingleRecords(item, { now }));
      allRecords.push(...records);
      pagesScanned += discovery.pages.length;
      const collectionProductsSeen = discovery.pages.reduce((sum, page) => sum + page.productCount, 0);
      productsSeen += collectionProductsSeen;
      results.push(Object.freeze({
        status: 'completed',
        reason: null,
        collectionKey: binding.key,
        canonicalSetId: binding.canonicalSetId,
        canonicalSetName: binding.canonicalSetName,
        canonicalCards: canonicalCards.length,
        productsSeen: collectionProductsSeen,
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
    } catch (error) {
      // One malformed/unavailable collection must never suppress clean exact
      // offers from the rest of the retailer. The failure stays visible in the
      // connector report and no records from this collection can be persisted.
      results.push(failedResult(configuredBinding, error));
    }
  }

  const completedCollections = results.filter((item) => item.status === 'completed');
  const heldCollections = results.filter((item) => item.status === 'held');
  const failedCollections = results.filter((item) => item.status === 'failed');
  const persistence = write && completedCollections.length
    ? await persistVerifiedRetailSingleRecords(store, {
      retailer: COB_PIP_RETAILER,
      records: allRecords,
      observedAt: Math.floor(Number(now) / 1000),
      pagesScanned,
      productsSeen,
    })
    : null;
  return Object.freeze({
    mode: write ? 'write' : 'dry-run',
    status: failedCollections.length ? 'partial' : 'completed',
    retailer: COB_PIP_RETAILER,
    generatedAt: new Date(now).toISOString(),
    collectionCount: results.length,
    completedCollectionCount: completedCollections.length,
    heldCollectionCount: heldCollections.length,
    failedCollectionCount: failedCollections.length,
    productsSeen,
    candidates: results.reduce((sum, item) => sum + Number(item.candidates || 0), 0),
    verified: results.reduce((sum, item) => sum + Number(item.verified || 0), 0),
    buyableVerified: results.reduce((sum, item) => sum + Number(item.buyableVerified || 0), 0),
    quarantined: results.reduce((sum, item) => sum + item.quarantined.length, 0),
    collections: Object.freeze(results),
    persistence,
  });
}

export const __test = Object.freeze({ assertCanonicalSet, resolveCanonicalBinding, selectedBindings });

export const COB_PIP_EXACT_CARD_CONNECTOR = Object.freeze({
  id: COB_PIP_RETAILER.id,
  retailer: COB_PIP_RETAILER,
  runCycle: runCobPipExactCardOfferCycle,
});
