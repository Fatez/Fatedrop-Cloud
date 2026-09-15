import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

export const CARDMARKET_URL_BASE = 'https://www.cardmarket.com/en/Pokemon/Products/Singles';

function asciiFold(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, '');
}

export function canonicalCollector(value) {
  try {
    return normaliseCollectorNumber(value);
  } catch {
    return String(value ?? '').trim().toLowerCase();
  }
}

export function identityKey({ setName, name, collectorNumber, variantCode }) {
  return [
    normaliseComparableName(setName),
    normaliseComparableName(name),
    canonicalCollector(collectorNumber),
    String(variantCode || '').trim().toLowerCase(),
  ].join('|');
}

export function cardmarketSetSlug(setName, overrides = {}) {
  const exact = overrides?.[setName];
  if (exact) return String(exact);
  return asciiFold(setName)
    .replace(/&/g, ' ')
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function cardmarketCardSlug(name, collectorNumber) {
  const collector = String(collectorNumber ?? '').trim().toUpperCase();
  const base = asciiFold(String(name ?? '')
    .replace(/♀/g, ' F ')
    .replace(/♂/g, ' M ')
    .replace(/δ/g, ' ')
    .replace(/LV\.X/gi, 'LVX')
    .replace(/(?<=\d)\.(?=\d)/g, ''))
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base}-${collector}`;
}

export function reviewedCardmarketUrl(identity, overrides = {}) {
  return `${CARDMARKET_URL_BASE}/${cardmarketSetSlug(identity.setName, overrides)}/${cardmarketCardSlug(identity.name, identity.collectorNumber)}`;
}

function structuredKey(name, collectorNumber) {
  return `${normaliseComparableName(name)}|${canonicalCollector(collectorNumber)}`;
}

export function buildCardmarketProductIndexes(products = []) {
  const byId = new Map();
  const byExpansion = new Map();
  const structuredGlobal = new Map();
  for (const product of products) {
    const id = String(product?.sourceRecordId ?? '').trim();
    if (!id) continue;
    byId.set(id, product);
    const expansion = String(product?.sourceExpansionId ?? '').trim();
    if (expansion) {
      const rows = byExpansion.get(expansion) || [];
      rows.push(product);
      byExpansion.set(expansion, rows);
    }
    const parsed = parseCardmarketSingleProductName(product?.name);
    if (parsed) {
      const key = structuredKey(parsed.cardName, parsed.collectorNumber);
      const rows = structuredGlobal.get(key) || [];
      rows.push(product);
      structuredGlobal.set(key, rows);
    }
  }
  return Object.freeze({ byId, byExpansion, structuredGlobal });
}

export function chooseDominantExpansion(counts, {
  minimumAnchors = 2,
  minimumShare = 0.9,
} = {}) {
  const entries = [...counts.entries()]
    .filter(([id, count]) => id && Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
  const [topId, topCount] = entries[0];
  const secondCount = entries[1]?.[1] || 0;
  if (entries.length === 1 && topCount >= 1) {
    return Object.freeze({ expansionId: String(topId), anchors: topCount, total, share: 1, secondCount: 0 });
  }
  if (topCount < minimumAnchors || topCount / total < minimumShare || topCount === secondCount) return null;
  return Object.freeze({ expansionId: String(topId), anchors: topCount, total, share: topCount / total, secondCount });
}

export function structuredExpansionVotes(identities, indexes) {
  const votes = new Map();
  for (const identity of identities || []) {
    const matches = indexes.structuredGlobal.get(structuredKey(identity.name, identity.collectorNumber)) || [];
    const expansions = new Set(matches.map((row) => String(row.sourceExpansionId ?? '')).filter(Boolean));
    for (const expansion of expansions) votes.set(expansion, (votes.get(expansion) || 0) + 1);
  }
  return votes;
}

export function resolveCardmarketProduct(identity, expansionId, indexes, priceById = new Map()) {
  const products = indexes.byExpansion.get(String(expansionId)) || [];
  const structured = products.filter((product) => {
    const parsed = parseCardmarketSingleProductName(product.name);
    return parsed
      && normaliseComparableName(parsed.cardName) === normaliseComparableName(identity.name)
      && canonicalCollector(parsed.collectorNumber) === canonicalCollector(identity.collectorNumber);
  });

  let matches = structured;
  let method = 'structured_name_collector';
  if (matches.length === 0) {
    matches = products.filter((product) => rootProductNameMatches(identity.name, product.name));
    method = 'unique_root_name_inside_expansion';
  }

  if (matches.length !== 1) {
    return Object.freeze({
      status: matches.length === 0 ? 'unresolved' : 'ambiguous',
      reason: matches.length === 0 ? 'NO_CARDMARKET_PRODUCT_MATCH' : 'MULTIPLE_CARDMARKET_PRODUCT_MATCHES',
      method,
      expansionId: String(expansionId),
      candidates: Object.freeze(matches.map((product) => Object.freeze({
        sourceRecordId: String(product.sourceRecordId),
        productName: product.name,
      }))),
    });
  }

  const product = matches[0];
  const priceRow = priceById.get(String(product.sourceRecordId));
  return Object.freeze({
    status: 'resolved',
    reason: 'EXACT_CARDMARKET_PRODUCT',
    method,
    expansionId: String(expansionId),
    sourceRecordId: String(product.sourceRecordId),
    productName: product.name,
    priceEvidence: Object.freeze({
      standard: Boolean(priceRow && hasMeaningfulCardmarketLane(priceRow, 'standard')),
      holo: Boolean(priceRow && hasMeaningfulCardmarketLane(priceRow, 'holo')),
    }),
  });
}

export async function probeReviewedUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') return Object.freeze({ status: 'unsupported' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'FateDrop-Cardmarket-Rebuild-Audit/1.0',
      },
    });
    const text = response.ok ? await response.text() : '';
    const ids = [...text.matchAll(/(?:idProduct|productId|product_id)["'=:\s]+(\d{3,})/gi)].map((match) => match[1]);
    return Object.freeze({
      status: response.status,
      ok: response.ok,
      finalUrl: response.url || url,
      discoveredProductIds: Object.freeze([...new Set(ids)]),
    });
  } catch (error) {
    return Object.freeze({ status: 'error', error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
  }
}
