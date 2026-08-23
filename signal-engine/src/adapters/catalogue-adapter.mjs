import { discoverProductLinks, extractCatalogueProducts, extractDirectProductPage } from "../core/extract.mjs";
import { fetchCataloguePage, sleep } from "../core/fetch.mjs";
import { productProbeUrlsForRetailer } from "./evidence-probes.mjs";

function withPage(url, param, page) {
  if (page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(param, String(page));
  return parsed.toString();
}

async function parseDirectFallback({ retailer, urls, pages, found }) {
  if (!urls.length) return 0;
  const limit = Math.max(1, Math.min(100, retailer.directProductFallbackLimit ?? 60));
  if (urls.length > limit) {
    throw new Error(`Catalogue card extraction returned zero products but exposed ${urls.length} product links, above direct fallback limit ${limit}; preserving last valid catalogue.`);
  }

  const concurrency = Math.max(1, Math.min(6, retailer.directProductFallbackConcurrency ?? 4));
  const delayMs = Math.max(250, retailer.directProductFallbackDelayMs ?? 500);
  let acceptedCount = 0;

  for (let offset = 0; offset < urls.length; offset += concurrency) {
    const batch = urls.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (pageUrl) => {
      const response = await fetchCataloguePage(pageUrl, retailer.fetchTimeoutMs);
      const product = extractDirectProductPage({ html: response.html, pageUrl, retailer });
      const accepted = product && (!retailer.include || retailer.include.test(`${product.title} ${product.url}`)) && (!retailer.exclude || !retailer.exclude.test(`${product.title} ${product.url}`));
      return { pageUrl, status: response.status, product: accepted ? product : null };
    }));

    for (const result of results) {
      if (result.product) {
        found.set(result.product.retailerSku, result.product);
        acceptedCount += 1;
      }
      pages.push({ pageUrl: result.pageUrl, discovered: result.product ? 1 : 0, status: result.status, source: "direct_product_fallback" });
    }
    if (offset + concurrency < urls.length) await sleep(delayMs);
  }

  return acceptedCount;
}

export async function scanRetailerCatalogue(retailer) {
  const found = new Map();
  const pages = [];
  const fallbackProductUrls = new Set();
  let catalogueProductsSeen = 0;
  for (const rootUrl of retailer.catalogueUrls) {
    let lastSize = -1;
    let lastFallbackSize = -1;
    for (let page = 1; page <= retailer.maxPages; page += 1) {
      const pageUrl = withPage(rootUrl, retailer.pageParam, page);
      const response = await fetchCataloguePage(pageUrl, retailer.fetchTimeoutMs);
      const products = extractCatalogueProducts({ html: response.html, pageUrl, retailer })
        .filter((item) => !retailer.include || retailer.include.test(`${item.title} ${item.url}`))
        .filter((item) => !retailer.exclude || !retailer.exclude.test(`${item.title} ${item.url}`));
      const discoveredLinks = discoverProductLinks({ html: response.html, pageUrl, retailer });
      discoveredLinks.forEach((url) => fallbackProductUrls.add(url));
      catalogueProductsSeen += products.length;
      for (const product of products) found.set(product.retailerSku, product);
      pages.push({ pageUrl, discovered: products.length, productLinks: discoveredLinks.length, status: response.status, source: "catalogue" });

      const noNewProducts = found.size === lastSize;
      const noNewLinks = fallbackProductUrls.size === lastFallbackSize;
      if (page > 1 && noNewProducts && noNewLinks) break;
      lastSize = found.size;
      lastFallbackSize = fallbackProductUrls.size;
      if (page < retailer.maxPages) await sleep(retailer.delayMs);
    }
  }

  let directFallbackProductsSeen = 0;
  if (catalogueProductsSeen === 0 && fallbackProductUrls.size > 0) {
    directFallbackProductsSeen = await parseDirectFallback({ retailer, urls: [...fallbackProductUrls], pages, found });
    catalogueProductsSeen += directFallbackProductsSeen;
  }

  let probeProductsSeen = 0;
  for (const pageUrl of productProbeUrlsForRetailer(retailer)) {
    const response = await fetchCataloguePage(pageUrl, retailer.fetchTimeoutMs);
    const product = extractDirectProductPage({ html: response.html, pageUrl, retailer });
    const accepted = product && (!retailer.include || retailer.include.test(`${product.title} ${product.url}`)) && (!retailer.exclude || !retailer.exclude.test(`${product.title} ${product.url}`));
    if (accepted) {
      found.set(product.retailerSku, product);
      probeProductsSeen += 1;
    }
    pages.push({ pageUrl, discovered: accepted ? 1 : 0, status: response.status, source: "product_probe" });
  }

  return {
    products: [...found.values()],
    pages,
    partialCatalogue: catalogueProductsSeen === 0 && probeProductsSeen > 0,
    catalogueProductsSeen,
    directFallbackProductsSeen,
    probeProductsSeen,
  };
}
