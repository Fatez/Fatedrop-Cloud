import { normalizeRetailerCandidate } from './registry.mjs';
import { transitionRetailer } from './lifecycle.mjs';

export function shuffledReviewedCandidate() {
  return normalizeRetailerCandidate({
    id: 'shuffled', name: 'Shuffled', websiteUrl: 'https://www.shuffled.gg/',
    retailerClass: 'specialist', adapterType: 'shopify', state: 'qualifying',
    verification: 'unverified', rrpAuthority: 'none', tcgs: ['pokemon'],
    catalogue: {
      urls: ['https://www.shuffled.gg/collections/pokemon'],
      feedUrl: 'https://www.shuffled.gg/collections/pokemon/products.json?limit=250',
      feedApproved: true,
      platformEvidence: ['2026-09-13: public Pokemon collection JSON exposes product variants, prices and boolean availability.'],
      runtime: {
        maxPages: 4, delayMs: 1200,
        include: String.raw`booster|elite trainer|\betb\b|collection|tin\b|blister|deck\b|bundle|display|box\b|pack\b`,
        exclude: String.raw`\bsingle\b(?![\s-]+(?:booster[\s-]+)?packs?\b)|single[\s-]+cards?|code[\s-]+cards?|sleeve|binder|play[\s-]?mat|toploader|graded|\bpsa\b|\bcgc\b|\bbgs\b|mystery|break[\s-]?slot`,
      },
    },
    monitoring: { activeTcgs: ['pokemon'], cadenceSeconds: 300, expectedMinimumProducts: 1 },
  });
}

// Pure preparation: caller holds the registry row lock before persisting once.
export function prepareShuffledActivation(existing, diagnostics) {
  const reviewed = shuffledReviewedCandidate();
  if (existing && (existing.id !== reviewed.id || existing.hostname !== reviewed.hostname)) throw new Error('Retailer identity conflict');
  if (existing?.verification === 'suspended') throw new Error('Suspended retailer requires separate review');
  if (existing && !['candidate', 'qualifying', 'ready'].includes(existing.state)) throw new Error(`Existing ${existing.state} retailer requires separate review`);
  if (!diagnostics?.catalogueComplete || !diagnostics?.stockMappingValidated || diagnostics.priceCoverage !== 1 || diagnostics.productsObserved < 1 || diagnostics.relevance?.likelyPokemonSealedCoverage !== 1) throw new Error('Incomplete retailer qualification');
  let candidate = normalizeRetailerCandidate({
    ...existing, ...reviewed,
    verification: existing?.verification || reviewed.verification,
    delivery: existing?.delivery || reviewed.delivery,
    physicalLocations: existing?.physicalLocations || 0,
    discovery: existing?.discovery || reviewed.discovery,
  });
  candidate = transitionRetailer(candidate, 'ready', diagnostics);
  return transitionRetailer(candidate, 'monitored', { ...diagnostics, explicitMonitoringApproval: true });
}
