import fs from 'node:fs';
import { COB_PIP_SINGLE_COLLECTIONS, collectCobPipSinglesPilot } from './cob-pip-singles-pilot.mjs';
import { buildVerifiedRetailSingleRecords, resolveRetailSingleBatch } from './retail-single-offers.mjs';

const PRODUCTION_BASE_URL = String(process.env.FATEDROP_PRODUCTION_BASE_URL || 'https://fatedrop-cloud-production.up.railway.app').replace(/\/$/, '');
const OUTPUT_PATH = String(process.env.OUTPUT_PATH || '').trim();
const VARIANTS = Object.freeze(['standard', 'holo', 'reverse-holo']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function productionGet(path) {
  const response = await fetch(`${PRODUCTION_BASE_URL}${path}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'FateDrop/0.1 (+https://fate-drop.com; retail-single-production-bundle)',
    },
  });
  if (!response.ok) throw new Error(`Production FateDrop read failed ${response.status} for ${path}`);
  const payload = await response.json();
  if (!payload?.ok || !payload?.data) throw new Error(`Production FateDrop returned an invalid envelope for ${path}`);
  return payload.data;
}

async function loadCanonicalSetCards(binding) {
  const byIdentity = new Map();
  let canonicalSet = null;
  for (const variant of VARIANTS) {
    const params = new URLSearchParams({ limit: '500', language: 'en', variant });
    const data = await productionGet(`/v1/fate-price/sets/${encodeURIComponent(binding.canonicalSetId)}/cards?${params}`);
    if (!data?.set || !Array.isArray(data.cards)) throw new Error(`Canonical set-card response invalid for ${binding.key}/${variant}`);
    if (!canonicalSet) canonicalSet = data.set;
    for (const card of data.cards) {
      const identity = text(card.fateCardId || card.id);
      if (identity) byIdentity.set(identity, card);
    }
  }
  if (!canonicalSet || canonicalSet.id !== binding.canonicalSetId
      || text(canonicalSet.name) !== binding.canonicalSetName
      || text(canonicalSet.tcgCode).toLowerCase() !== binding.tcgCode
      || text(canonicalSet.verificationStatus).toLowerCase() !== 'verified') {
    throw new Error(`Reviewed set binding no longer matches production canonical catalogue for ${binding.key}`);
  }
  return { set: canonicalSet, cards: [...byIdentity.values()] };
}

function assertBundleRecords(records) {
  const offerToCard = new Map();
  for (const record of records) {
    if (!record?.offer?.offerId || !record?.mapping?.cardIdentityId) throw new Error('Generated record missing offer or card identity');
    if (record.mapping.verificationStatus !== 'verified') throw new Error(`Non-verified mapping generated for ${record.offer.offerId}`);
    if (record.mapping.offerId !== record.offer.offerId) throw new Error(`Offer/mapping ID mismatch for ${record.offer.offerId}`);
    if (record.product.id !== record.offer.productId) throw new Error(`Product/offer ID mismatch for ${record.offer.offerId}`);
    const previous = offerToCard.get(record.offer.offerId);
    if (previous && previous !== record.mapping.cardIdentityId) throw new Error(`Generated offer identity conflict for ${record.offer.offerId}`);
    offerToCard.set(record.offer.offerId, record.mapping.cardIdentityId);
  }
}

async function main() {
  const generatedAtMs = Date.now();
  const collections = [];
  const records = [];

  for (const binding of Object.values(COB_PIP_SINGLE_COLLECTIONS)) {
    const [{ set, cards }, discovery] = await Promise.all([
      loadCanonicalSetCards(binding),
      collectCobPipSinglesPilot({ collection: binding, observedAt: generatedAtMs }),
    ]);
    const resolution = resolveRetailSingleBatch(discovery.candidates, { binding, canonicalCards: cards });
    const collectionRecords = resolution.verified.map((item) => buildVerifiedRetailSingleRecords(item, { now: generatedAtMs }));
    assertBundleRecords(collectionRecords);
    records.push(...collectionRecords);
    collections.push({
      collectionKey: binding.key,
      collectionHandle: binding.collectionHandle,
      canonicalSetId: binding.canonicalSetId,
      canonicalSetName: binding.canonicalSetName,
      canonicalCards: cards.length,
      productsSeen: discovery.pages.reduce((sum, page) => sum + page.productCount, 0),
      pages: discovery.pages,
      ...resolution.counts,
      quarantineReasons: Object.fromEntries(
        [...new Set(resolution.quarantined.map((item) => item.reason))]
          .sort()
          .map((reason) => [reason, resolution.quarantined.filter((item) => item.reason === reason).length]),
      ),
      quarantined: resolution.quarantined.map((item) => ({
        reason: item.reason,
        retailerProductId: item.candidate.retailerProductId,
        retailerVariantId: item.candidate.retailerVariantId,
        productTitle: item.candidate.productTitle,
        variantTitle: item.candidate.variantTitle,
        evidence: item.evidence,
      })),
    });
  }

  assertBundleRecords(records);
  const result = {
    schemaVersion: 'retail-single-production-bundle:1',
    mode: 'read_only_exact_bundle',
    writesPerformed: false,
    generatedAt: new Date(generatedAtMs).toISOString(),
    productionBaseUrl: PRODUCTION_BASE_URL,
    retailer: { id: 'cob-pip', name: 'Cob & Pip' },
    collections,
    totals: {
      candidates: collections.reduce((sum, item) => sum + item.candidates, 0),
      verified: collections.reduce((sum, item) => sum + item.verified, 0),
      buyableVerified: collections.reduce((sum, item) => sum + item.buyableVerified, 0),
      quarantined: collections.reduce((sum, item) => sum + item.quarantined.length, 0),
      records: records.length,
    },
    records,
  };

  const json = JSON.stringify(result, null, 2);
  if (OUTPUT_PATH) fs.writeFileSync(OUTPUT_PATH, json);
  console.log(JSON.stringify({
    schemaVersion: result.schemaVersion,
    mode: result.mode,
    writesPerformed: result.writesPerformed,
    generatedAt: result.generatedAt,
    retailer: result.retailer,
    collections: collections.map(({ collectionKey, canonicalSetId, canonicalSetName, canonicalCards, productsSeen, candidates, verified, buyableVerified, quarantined, quarantineReasons }) => ({
      collectionKey, canonicalSetId, canonicalSetName, canonicalCards, productsSeen, candidates, verified, buyableVerified, quarantined: quarantined.length, quarantineReasons,
    })),
    totals: result.totals,
    outputPath: OUTPUT_PATH || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
