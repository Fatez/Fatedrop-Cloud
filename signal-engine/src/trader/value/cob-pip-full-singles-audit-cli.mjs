import fs from 'node:fs';

import { COB_PIP_RETAILER, COB_PIP_SINGLE_COLLECTIONS, collectCobPipSinglesPilot } from './cob-pip-singles-pilot.mjs';
import { resolveRetailSingleBatch } from './retail-single-offers.mjs';

const DEFAULT_BASE_URL = 'https://fatedrop-cloud-production.up.railway.app';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'FateDrop/0.1 (+https://fate-drop.com; read-only-retail-coverage-audit)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  const payload = await response.json();
  if (!payload?.ok || payload?.data == null) throw new Error(`Invalid FateDrop response from ${url}`);
  return payload.data;
}

async function productionSets(baseUrl) {
  const data = await fetchJson(`${baseUrl}/v1/fate-price/sets?tcg=pokemon&limit=1000`);
  return Array.isArray(data.sets) ? data.sets : [];
}

function resolveBinding(binding, sets) {
  if (binding.canonicalSetId) {
    const set = sets.find((candidate) => candidate.id === binding.canonicalSetId) || null;
    if (!set) return { status: 'held', reason: 'canonical_set_id_unavailable', binding, set: null };
    if (text(set.name) !== binding.canonicalSetName || text(set.tcgCode).toLowerCase() !== binding.tcgCode) {
      return { status: 'held', reason: 'canonical_set_binding_mismatch', binding, set: null };
    }
    return { status: 'ready', reason: null, binding, set };
  }

  const matches = sets.filter((candidate) => text(candidate.name) === binding.canonicalSetName && text(candidate.tcgCode).toLowerCase() === binding.tcgCode);
  if (!matches.length) return { status: 'held', reason: 'canonical_set_unavailable', binding, set: null };
  if (matches.length !== 1) return { status: 'held', reason: 'canonical_set_name_conflict', binding, set: null };
  const set = matches[0];
  return { status: 'ready', reason: null, binding: Object.freeze({ ...binding, canonicalSetId: set.id }), set };
}

async function productionCards(baseUrl, binding) {
  const url = `${baseUrl}/v1/fate-price/sets/${encodeURIComponent(binding.canonicalSetId)}/cards?language=en&limit=500`;
  const data = await fetchJson(url);
  if (data?.set?.id !== binding.canonicalSetId || text(data?.set?.name) !== binding.canonicalSetName) {
    throw new Error(`Production set/card contract mismatch for ${binding.key}`);
  }
  const cards = Array.isArray(data.cards) ? data.cards : [];
  if (Number(data.count) !== cards.length) throw new Error(`Production card count mismatch for ${binding.key}`);
  return cards;
}

function reasonCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.reason] = (counts[row.reason] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function auditCollection(baseUrl, configuredBinding, sets, observedAt) {
  const canonical = resolveBinding(configuredBinding, sets);
  if (canonical.status !== 'ready') {
    return Object.freeze({
      status: 'held',
      reason: canonical.reason,
      collectionKey: configuredBinding.key,
      collectionHandle: configuredBinding.collectionHandle,
      canonicalSetId: configuredBinding.canonicalSetId || null,
      canonicalSetName: configuredBinding.canonicalSetName,
      canonicalCards: 0,
      productsSeen: 0,
      candidates: 0,
      verified: 0,
      buyableVerified: 0,
      quarantined: 0,
      quarantineReasons: Object.freeze({ [canonical.reason]: 1 }),
    });
  }

  const binding = canonical.binding;
  try {
    const [canonicalCards, discovery] = await Promise.all([
      productionCards(baseUrl, binding),
      collectCobPipSinglesPilot({ collection: binding, observedAt }),
    ]);
    const resolution = resolveRetailSingleBatch(discovery.candidates, { binding, canonicalCards });
    return Object.freeze({
      status: 'completed',
      reason: null,
      collectionKey: binding.key,
      collectionHandle: binding.collectionHandle,
      canonicalSetId: binding.canonicalSetId,
      canonicalSetName: binding.canonicalSetName,
      canonicalCards: canonicalCards.length,
      productsSeen: discovery.pages.reduce((sum, page) => sum + page.productCount, 0),
      candidates: resolution.counts.candidates,
      verified: resolution.counts.verified,
      buyableVerified: resolution.counts.buyableVerified,
      quarantined: resolution.counts.quarantined,
      quarantineReasons: Object.freeze(reasonCounts(resolution.quarantined)),
      quarantinedSamples: Object.freeze(resolution.quarantined.slice(0, 20).map((row) => Object.freeze({
        reason: row.reason,
        retailerVariantId: row.candidate.retailerVariantId,
        title: row.candidate.productTitle,
        variantTitle: row.candidate.variantTitle,
        evidence: row.evidence,
      }))),
    });
  } catch (error) {
    return Object.freeze({
      status: 'failed',
      reason: 'collection_audit_failed',
      collectionKey: binding.key,
      collectionHandle: binding.collectionHandle,
      canonicalSetId: binding.canonicalSetId,
      canonicalSetName: binding.canonicalSetName,
      canonicalCards: 0,
      productsSeen: 0,
      candidates: 0,
      verified: 0,
      buyableVerified: 0,
      quarantined: 0,
      quarantineReasons: Object.freeze({ collection_audit_failed: 1 }),
      error: Object.freeze({ name: String(error?.name || 'Error'), message: String(error?.message || error) }),
    });
  }
}

async function main() {
  const baseUrl = text(process.env.FATEDROP_PRODUCTION_BASE_URL) || DEFAULT_BASE_URL;
  const outputPath = text(process.env.OUTPUT_PATH) || 'cob-pip-full-singles-audit.json';
  const observedAt = Date.now();
  const sets = await productionSets(baseUrl);
  const results = [];
  for (const binding of Object.values(COB_PIP_SINGLE_COLLECTIONS)) {
    results.push(await auditCollection(baseUrl, binding, sets, observedAt));
  }

  const completed = results.filter((row) => row.status === 'completed');
  const held = results.filter((row) => row.status === 'held');
  const failed = results.filter((row) => row.status === 'failed');
  const report = Object.freeze({
    schemaVersion: 'cob-pip-full-singles-audit:1',
    mode: 'read_only_live_exact_coverage',
    writesPerformed: false,
    generatedAt: new Date(observedAt).toISOString(),
    productionBaseUrl: baseUrl,
    retailer: COB_PIP_RETAILER,
    reviewedCollectionCount: results.length,
    productionVerifiedPokemonSetCount: sets.length,
    completedCollectionCount: completed.length,
    heldCollectionCount: held.length,
    failedCollectionCount: failed.length,
    totals: Object.freeze({
      productsSeen: results.reduce((sum, row) => sum + row.productsSeen, 0),
      candidates: results.reduce((sum, row) => sum + row.candidates, 0),
      verified: results.reduce((sum, row) => sum + row.verified, 0),
      buyableVerified: results.reduce((sum, row) => sum + row.buyableVerified, 0),
      quarantined: results.reduce((sum, row) => sum + row.quarantined, 0),
    }),
    collections: Object.freeze(results),
  });

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    mode: report.mode,
    writesPerformed: report.writesPerformed,
    reviewedCollectionCount: report.reviewedCollectionCount,
    completedCollectionCount: report.completedCollectionCount,
    heldCollectionCount: report.heldCollectionCount,
    failedCollectionCount: report.failedCollectionCount,
    totals: report.totals,
    outputPath,
  }, null, 2));

  if (failed.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
