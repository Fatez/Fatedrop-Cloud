const RETAILER_PRODUCT_PROBES = Object.freeze({
  "magic-madhouse": [
    "https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box",
  ],
});

export function productProbeUrlsForRetailer(retailer) {
  return [...(RETAILER_PRODUCT_PROBES[retailer?.id] || [])];
}
