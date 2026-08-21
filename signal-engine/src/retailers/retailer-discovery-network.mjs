import { deduplicateRetailerCandidates } from "./discovery.mjs";
import { ukRetailerDiscoverySeeds } from "./uk-discovery-network.mjs";
import { internationalUkAccessibleRetailers20260821 } from "./international-uk-accessible-2026-08-21.mjs";

export const retailerDiscoverySeeds = deduplicateRetailerCandidates([
  ...ukRetailerDiscoverySeeds,
  ...internationalUkAccessibleRetailers20260821,
]);

export const retailerDiscoveryStats = Object.freeze({
  ukCandidates: ukRetailerDiscoverySeeds.length,
  internationalUkAccessibleCandidates: internationalUkAccessibleRetailers20260821.length,
  uniqueCandidates: retailerDiscoverySeeds.length,
  shipsToUkConfirmed: retailerDiscoverySeeds.filter((row) => row.delivery.shipsToUk === true).length,
  internationalRuntimeBlocked: retailerDiscoverySeeds.filter((row) => row.countryCode !== "GB").length,
});
