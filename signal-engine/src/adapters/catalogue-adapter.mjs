import { discoverProductLinks, extractCatalogueProducts, extractDirectProductPage } from "../core/extract.mjs";
import { fetchCataloguePage, sleep } from "../core/fetch.mjs";
import { productProbeUrlsForRetailer } from "./evidence-probes.mjs";

function withPage(url, param, page) {
  if (page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(param, String(page));
  return parsed.toString();
}

function matches(pattern, value) {
  if (!pattern) return true;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function productAccepted(product, retailer) {
  if (!product) return false;
  const value = `${product.title} ${product.url}`;
  if (retailer.include && !matches(retailer.include, value)) return false;
  if (retailer.exclude && matches(retailer.exclude, value)) return false;
  return true;
}

function productUrlKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

export function unresolvedProductLinks(discoveredUrls, representedUrls) {
  const represented = new Set((representedUrls || []).map(productUrlKey).filter(Boolean));
  return [...new Set(discoveredUrls || [])].filter((url) => {
    const key = productUrlKey(url);
    return key && !represented.has(key);
  });
}

async function parseDirectProducts({ retailer, urls, pages, found, source, limit, failIfTruncated = false }) {
  if (!urls.length) return { acceptedCount: 0, attemptedCount: 0, filteredOutCount: 0, truncatedCount: 0 };
  const safeLimit = Math.max(1, Math.min(100, limit));
  if (failIfTruncated && urls.length > safeLimit) {
    throw new Error(`Catalogue card extraction returned zero products but exposed ${urls.length} product links, above direct fallback limit ${safeLimit}; preserving last valid catalogue.`);
  }

  const selected = urls.slice(0, safeLimit);
  const concurrency = Math.max(1, Math.min(6, retailer.directProductFallbackConcurrency ?? 4));
  const delayMs = Math.max(250, retailer.directProductFallbackDelayMs ?? 500);
  let acceptedCount = 0;
  let filteredOutCount = 0;

  for (let offset = 0; offset < selected.length; offset += concurrency) {
    const batch = selected.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (pageUrl) => {
      const response = await fetchCataloguePage(pageUrl, retailer.fetchTimeoutMs);
      const product = extractDirectProductPage({ html: response.html, pageUrl, retailer });
      const accepted = productAccepted(product, retailer);
      return { pageUrl, status: response.status, product: accepted ? product : null, filteredOut: Boolean(product && !accepted) };
    }));

    for (const result of results) {
      if (result.product) {
        found.set(result.product.retailerSku, result.product);
        acceptedCount += 1;
      }
      if (result.filteredOut) filteredOutCount += 1;
      pages.push({
        pageUrl: result.pageUrl,
        discovered: result.product ? 1 : 0,
        filteredOut: result.filteredOut ? 1 : 0,
        status: result.status,
        source,
      });
    }
    if (offset + concurrency < selected.length) await sleep(delayMs);
  }

  return {
    acceptedCount,
    attemptedCount: selected.length,
    filteredOutCount,
    truncatedCount: Math.max(0, urls.length - selected.length),
  };
}

export async function scanRetailerCatalogue(retailer) {
  const found = new Map();
  const pages = [];
  const fallbackProductUrls = new Set();
  const representedCardUrls = new Set();
  let catalogueProductsSeen = 0;
  let catalogueRawProductsSeen = 0;
  let catalogueFilteredOutProducts = 0;

  for (const rootUrl of retailer.catalogueUrls) {
    let lastSize = -1;
    let lastFallbackSize = -1;
    for (let page = 1; page <= retailer.maxPages; page += 1) {
      const pageUrl = withPage(rootUrl, retailer.pageParam, page);
      const response = await fetchCataloguePage(pageUrl, retailer.fetchTimeoutMs, {
        stencilTemplate: retailer.catalogue?.stencilTemplate,
      });
      const rawProducts = extractCatalogueProducts({ html: response.html, pageUrl, retailer });
      rawProducts.forEach((item) => representedCardUrls.add(item.url));
      const products = rawProducts.filter((item) => productAccepted(item, retailer));
      const discoveredLinks = discoverProductLinks({ html: response.html, pageUrl, retailer });
      discoveredLinks.forEach((url) => fallbackProductUrls.add(url));

      catalogueRawProductsSeen += rawProducts.length;
      catalogueFilteredOutProducts += rawProducts.length - products.length;
      catalogueProductsSeen += products.length;
      for (const product of products) found.set(product.retailerSku, product);
      pages.push({
        pageUrl,
        discovered: products.length,
        rawDiscovered: rawProducts.length,
        filteredOut: rawProducts.length - products.length,
        productLinks: discoveredLinks.length,
        status: response.status,
        source: "catalogue",
      });

      const noNewProducts = found.size === lastSize;
      const noNewLinks = fallbackProductUrls.size === lastFallbackSize;
      if (page > 1 && noNewProducts && noNewLinks) break;
      lastSize = found.size;
      lastFallbackSize = fallbackProductUrls.size;
      if (page < retailer.maxPages) await sleep(retailer.delayMs);
    }
  }

  const unresolvedLinks = unresolvedProductLinks([...fallbackProductUrls], [...representedCardUrls]);
  let directFallbackProductsSeen = 0;
  let directRecoveryProductsSeen = 0;
  let directRecoveryAttempted = 0;
  let directRecoveryFilteredOut = 0;
  let directRecoveryTruncated = 0;

  if (catalogueProductsSeen === 0 && fallbackProductUrls.size > 0) {
    const fallback = await parseDirectProducts({
      retailer,
      urls: unresolvedLinks.length ? unresolvedLinks : [...fallbackProductUrls],
      pages,
      found,
      source: "direct_product_fallback",
      limit: retailer.directProductFallbackLimit ?? 60,
      failIfTruncated: true,
    });
    directFallbackProductsSeen = fallback.acceptedCount;
    directRecoveryAttempted += fallback.attemptedCount;
    directRecoveryFilteredOut += fallback.filteredOutCount;
    directRecoveryTruncated += fallback.truncatedCount;
    catalogueProductsSeen += directFallbackProductsSeen;
  } else if (unresolvedLinks.length > 0) {
    const recovery = await parseDirectProducts({
      retailer,
      urls: unresolvedLinks,
      pages,
      found,
      source: "direct_product_recovery",
      limit: retailer.directProductRecoveryLimit ?? 24,
      failIfTruncated: false,
    });
    directRecoveryProductsSeen = recovery.acceptedCount;
    directRecoveryAttempted += recovery.attemptedCount;
    directRecoveryFilteredOut += recovery.filteredOutCount;
    directRecoveryTruncated += recovery.truncatedCount;
    catalogueProductsSeen += directRecoveryProductsSeen;
  }

  let probeProductsSeen = 0;
  let probeProductsFilteredOut = 0;
  for (const pageUrl of productProbeUrlsForRetailer(retailer)) {
    const response = await fetchCataloguePage(pageUrl, retailer.fetchTimeoutMs);
    const product = extractDirectProductPage({ html: response.html, pageUrl, retailer });
    const accepted = productAccepted(product, retailer);
    if (accepted) {
      found.set(product.retailerSku, product);
      probeProductsSeen += 1;
    } else if (product) {
      probeProductsFilteredOut += 1;
    }
    pages.push({ pageUrl, discovered: accepted ? 1 : 0, filteredOut: product && !accepted ? 1 : 0, status: response.status, source: "product_probe" });
  }

  return {
    products: [...found.values()],
    pages,
    partialCatalogue: catalogueProductsSeen === 0 && probeProductsSeen > 0,
    catalogueProductsSeen,
    catalogueRawProductsSeen,
    catalogueFilteredOutProducts,
    productLinksSeen: fallbackProductUrls.size,
    unresolvedProductLinksSeen: unresolvedLinks.length,
    directFallbackProductsSeen,
    directRecoveryProductsSeen,
    directRecoveryAttempted,
    directRecoveryFilteredOut,
    directRecoveryTruncated,
    probeProductsSeen,
    probeProductsFilteredOut,
  };
}
