import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "./registry.mjs";

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

export function prepareCandidateDryRun(input, { allowStructuredFeedProbe = false } = {}) {
  const retailer = normalizeRetailerCandidate(input);
  if (![ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    return retailer;
  }

  if (retailer.catalogue.feedApproved === true) return retailer;
  if (!allowStructuredFeedProbe) {
    throw new Error(`${retailer.id} structured feed is unapproved; pass the explicit dry-run probe flag to test it without persisting approval`);
  }
  if (!retailer.catalogue.feedUrl) throw new Error(`${retailer.id} has no structured feed candidate to probe`);

  const websiteHost = hostname(retailer.websiteUrl);
  const feedHost = hostname(retailer.catalogue.feedUrl);
  if (!websiteHost || !feedHost || websiteHost !== feedHost) {
    throw new Error(`${retailer.id} structured feed probe must stay on the retailer website hostname`);
  }

  return normalizeRetailerCandidate({
    ...retailer,
    state: RETAILER_STATES.QUALIFYING,
    catalogue: {
      ...retailer.catalogue,
      feedApproved: true,
    },
    discovery: retailer.discovery,
  });
}
