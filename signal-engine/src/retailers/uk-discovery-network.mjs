import { deduplicateRetailerCandidates } from "./discovery.mjs";
import { ukRetailerDiscoverySeeds as foundationSeeds } from "./uk-discovery-seeds.mjs";
import { ukRetailerExpansion20260821 } from "./uk-discovery-expansion-2026-08-21.mjs";

export const ukRetailerDiscoverySeeds = deduplicateRetailerCandidates([
  ...foundationSeeds,
  ...ukRetailerExpansion20260821,
]);

export const ukRetailerDiscoveryStats = Object.freeze({
  foundation: foundationSeeds.length,
  expansion20260821: ukRetailerExpansion20260821.length,
  unique: ukRetailerDiscoverySeeds.length,
});
