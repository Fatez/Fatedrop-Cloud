const POLICIES = Object.freeze({
  'cardmarket-public-download': Object.freeze({
    key: 'cardmarket-public-download',
    sourceName: 'cardmarket',
    acquisitionMode: 'public-download',
    status: 'approved',
    reviewedAt: '2026-09-03',
    notes: 'Use Cardmarket public downloadable price-guide/product-catalogue files for standard/holo aggregate market evidence.',
  }),
  'cardmarket-public-product-page': Object.freeze({
    key: 'cardmarket-public-product-page',
    sourceName: 'cardmarket',
    acquisitionMode: 'public-product-page',
    status: 'approved',
    reviewedAt: '2026-09-15',
    notes: 'Read-only exact Cardmarket product URLs may be used for reverse-holo offer evidence. Keep the certified product ID as the identity anchor; use public language=1 and isReverseHolo=Y filters; never substitute normal/holo prices or call listing-derived values Trend/AVG sales metrics.',
  }),
  'pokemon-wizard': Object.freeze({
    key: 'pokemon-wizard',
    sourceName: 'pokemon-wizard',
    acquisitionMode: 'website',
    status: 'blocked',
    reviewedAt: '2026-09-03',
    notes: 'Do not scrape, systematically extract, reproduce or redistribute pricing data without explicit written permission/licensing.',
  }),
  'tcgplayer-api': Object.freeze({
    key: 'tcgplayer-api',
    sourceName: 'tcgplayer',
    acquisitionMode: 'api',
    status: 'approval-required',
    reviewedAt: '2026-09-03',
    notes: 'Do not ingest into Fate Price unless FateDrop has explicit provider approval for the intended commercial/aggregation use.',
  }),
  'cardmarket-api': Object.freeze({
    key: 'cardmarket-api',
    sourceName: 'cardmarket',
    acquisitionMode: 'api',
    status: 'approval-required',
    reviewedAt: '2026-09-03',
    notes: 'Authenticated API access is not required by the approved FateDrop reverse-holo path. Keep it outside the V1 ingestion path unless separately approved.',
  }),
});

export const FATE_PRICE_PROVIDER_POLICIES = POLICIES;

export function getFatePriceProviderPolicy(key) {
  const normalized = String(key || '').trim().toLowerCase();
  return POLICIES[normalized] ?? null;
}

export function assertFatePriceProviderApproved(key) {
  const policy = getFatePriceProviderPolicy(key);
  if (!policy) {
    const error = new Error(`Pricing source has no reviewed FateDrop policy: ${key}`);
    error.code = 'PRICING_SOURCE_UNREVIEWED';
    throw error;
  }
  if (policy.status !== 'approved') {
    const error = new Error(`Pricing source is not approved for FateDrop ingestion: ${policy.key}`);
    error.code = policy.status === 'blocked' ? 'PRICING_SOURCE_BLOCKED' : 'PRICING_SOURCE_APPROVAL_REQUIRED';
    error.policy = policy;
    throw error;
  }
  return policy;
}
