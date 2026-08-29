const DEFAULT_POLICY = Object.freeze({
  officialCatalogueListingEvidence: false,
  officialProductPageEvidence: false,
  requireVerifiedPurchaseEvidence: false,
});

const RETAILER_LIFECYCLE_POLICIES = Object.freeze({
  "smyths-uk": Object.freeze({
    officialCatalogueListingEvidence: true,
    officialProductPageEvidence: true,
    requireVerifiedPurchaseEvidence: true,
  }),
});

export function retailerLifecyclePolicy(retailerId) {
  return RETAILER_LIFECYCLE_POLICIES[retailerId] || DEFAULT_POLICY;
}
